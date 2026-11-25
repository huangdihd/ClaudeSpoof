using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

public static class MemoryFuseLauncher
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint PAGE_READWRITE = 0x04;
    private const uint IMAGE_SCN_MEM_EXECUTE = 0x20000000;
    private const uint IMAGE_SCN_MEM_READ = 0x40000000;
    private static readonly byte[] FuseSentinel = Encoding.ASCII.GetBytes("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    private struct SectionRange
    {
        public int VirtualAddress;
        public int Size;
        public bool IsDataPreferred;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr process, IntPtr baseAddress,
        byte[] buffer, int size, out IntPtr bytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteProcessMemory(IntPtr process, IntPtr baseAddress,
        byte[] buffer, int size, out IntPtr bytesWritten);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualProtectEx(IntPtr process, IntPtr address,
        UIntPtr size, uint newProtect, out uint oldProtect);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushInstructionCache(IntPtr process, IntPtr baseAddress, UIntPtr size);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int processInformationClass,
        ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);

    private static byte[] ReadRemote(IntPtr process, long address, int size)
    {
        byte[] data = new byte[size];
        IntPtr read;
        if (!ReadProcessMemory(process, new IntPtr(address), data, size, out read) || read.ToInt64() != size)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "ReadProcessMemory failed at 0x" + address.ToString("x"));
        return data;
    }

    private static bool TryReadRemote(IntPtr process, long address, int size, out byte[] data)
    {
        data = new byte[size];
        IntPtr read;
        return ReadProcessMemory(process, new IntPtr(address), data, size, out read) && read.ToInt64() == size;
    }

    private static int SearchRange(IntPtr process, long imageBase, int startOffset, int length)
    {
        const int chunkSize = 1024 * 1024;
        int endOffset = startOffset + length;
        for (int offset = startOffset; offset < endOffset; offset += chunkSize)
        {
            int count = Math.Min(chunkSize + FuseSentinel.Length, endOffset - offset);
            if (count < FuseSentinel.Length) break;
            byte[] data;
            if (!TryReadRemote(process, imageBase + offset, count, out data)) continue;
            for (int i = 0; i <= count - FuseSentinel.Length; i++)
            {
                bool match = true;
                for (int j = 0; j < FuseSentinel.Length; j++)
                {
                    if (data[i + j] != FuseSentinel[j]) { match = false; break; }
                }
                if (match) return offset + i;
            }
        }
        return -1;
    }

    private static List<SectionRange> ReadPeSections(IntPtr process, long imageBase, int peOffset, int imageSize)
    {
        var ranges = new List<SectionRange>();
        byte[] fileHeader = ReadRemote(process, imageBase + peOffset + 4, 20);
        int numberOfSections = BitConverter.ToUInt16(fileHeader, 2);
        int sizeOfOptionalHeader = BitConverter.ToUInt16(fileHeader, 16);
        long sectionTableAddress = imageBase + peOffset + 24 + sizeOfOptionalHeader;
        if (numberOfSections <= 0 || numberOfSections > 128) return ranges;

        byte[] table = ReadRemote(process, sectionTableAddress, numberOfSections * 40);
        for (int i = 0; i < numberOfSections; i++)
        {
            int off = i * 40;
            int virtualSize = BitConverter.ToInt32(table, off + 8);
            int virtualAddress = BitConverter.ToInt32(table, off + 12);
            int rawSize = BitConverter.ToInt32(table, off + 16);
            uint characteristics = BitConverter.ToUInt32(table, off + 36);
            int size = Math.Max(virtualSize, rawSize);
            if (virtualAddress <= 0 || size <= 0 || virtualAddress >= imageSize) continue;
            if (virtualAddress + size > imageSize) size = imageSize - virtualAddress;
            bool readable = (characteristics & IMAGE_SCN_MEM_READ) != 0;
            bool executable = (characteristics & IMAGE_SCN_MEM_EXECUTE) != 0;
            if (!readable) continue;
            ranges.Add(new SectionRange
            {
                VirtualAddress = virtualAddress,
                Size = size,
                IsDataPreferred = !executable
            });
        }
        return ranges;
    }

    private static int FindSentinel(IntPtr process, long imageBase, int peOffset, int imageSize)
    {
        List<SectionRange> sections = ReadPeSections(process, imageBase, peOffset, imageSize);
        // Prefer readable non-executable data sections (.rdata/.data) first for speed & safety.
        for (int pass = 0; pass < 2; pass++)
        {
            bool wantData = (pass == 0);
            foreach (SectionRange sec in sections)
            {
                if (sec.IsDataPreferred != wantData) continue;
                int found = SearchRange(process, imageBase, sec.VirtualAddress, sec.Size);
                if (found >= 0) return found;
            }
        }
        int fallback = SearchRange(process, imageBase, 0, imageSize);
        if (fallback >= 0) return fallback;
        throw new Exception("Electron fuse sentinel was not found in the official process image");
    }

    private static int AllocateEphemeralPort()
    {
        TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        try
        {
            listener.Start();
            return ((IPEndPoint)listener.LocalEndpoint).Port;
        }
        finally
        {
            listener.Stop();
        }
    }

    private static string QuoteArg(string arg)
    {
        if (string.IsNullOrEmpty(arg)) return "\"\"";
        if (arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
        var sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        for (int i = 0; i < arg.Length; i++)
        {
            char c = arg[i];
            if (c == '\\') { backslashes++; }
            else if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
            }
            else
            {
                if (backslashes > 0) { sb.Append('\\', backslashes); backslashes = 0; }
                sb.Append(c);
            }
        }
        if (backslashes > 0) sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    private static string EscapeJson(string value)
    {
        if (value == null) return "";
        var sb = new StringBuilder(value.Length);
        foreach (char c in value)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u" + ((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    public static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("Usage: MemoryFuseLauncher.exe <official Claude.exe> <inspector port|0> [extra args...]");
            return 2;
        }
        string executable = Path.GetFullPath(args[0]);
        int port;
        if (!int.TryParse(args[1], out port) || port < 0 || port > 65535)
        {
            Console.Error.WriteLine("Invalid inspector port: " + args[1]);
            return 2;
        }
        if (port == 0) port = AllocateEphemeralPort();

        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        bool created = false;
        try
        {
            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            var cmd = new StringBuilder();
            cmd.Append(QuoteArg(executable));
            cmd.Append(" --inspect-brk=127.0.0.1:");
            cmd.Append(port);
            for (int i = 2; i < args.Length; i++)
            {
                cmd.Append(' ');
                cmd.Append(QuoteArg(args[i]));
            }

            if (!CreateProcess(executable, cmd, IntPtr.Zero, IntPtr.Zero, false,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero,
                Path.GetDirectoryName(executable), ref si, out pi))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed with Win32 error " + Marshal.GetLastWin32Error());
            created = true;

            PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
            int returnLength;
            int status = NtQueryInformationProcess(pi.hProcess, 0, ref pbi, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returnLength);
            if (status != 0) throw new Exception("NtQueryInformationProcess returned 0x" + status.ToString("x8"));
            long peb = pbi.PebBaseAddress.ToInt64();
            long imageBase = BitConverter.ToInt64(ReadRemote(pi.hProcess, peb + 0x10, 8), 0);
            int peOffset = BitConverter.ToInt32(ReadRemote(pi.hProcess, imageBase + 0x3c, 4), 0);
            int imageSize = BitConverter.ToInt32(ReadRemote(pi.hProcess, imageBase + peOffset + 0x50, 4), 0);
            if (imageSize <= 0 || imageSize > 1024 * 1024 * 1024) throw new Exception("Invalid image size: " + imageSize);

            int sentinelOffset = FindSentinel(pi.hProcess, imageBase, peOffset, imageSize);
            byte[] fuseHeader = ReadRemote(pi.hProcess, imageBase + sentinelOffset + FuseSentinel.Length, 2);
            int fuseVersion = fuseHeader[0];
            int wireLength = fuseHeader[1];
            if (fuseVersion != 1)
                throw new Exception("Unsupported Electron fuse version: " + fuseVersion);
            if (wireLength <= 3)
                throw new Exception("Invalid Electron fuse wire length: " + wireLength);

            long wireAddress = imageBase + sentinelOffset + FuseSentinel.Length + 2;
            byte[] wire = ReadRemote(pi.hProcess, wireAddress, wireLength);
            string oldWire = Encoding.ASCII.GetString(wire);
            if (wire[3] != (byte)'0' && wire[3] != (byte)'1')
                throw new Exception("Unexpected Node inspect fuse value: " + wire[3]);

            long target = wireAddress + 3;
            uint oldProtect;
            if (!VirtualProtectEx(pi.hProcess, new IntPtr(target), new UIntPtr(1), PAGE_READWRITE, out oldProtect))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "VirtualProtectEx failed");
            IntPtr written;
            byte[] enabled = { (byte)'1' };
            if (!WriteProcessMemory(pi.hProcess, new IntPtr(target), enabled, 1, out written) || written.ToInt64() != 1)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WriteProcessMemory failed");
            uint ignored;
            VirtualProtectEx(pi.hProcess, new IntPtr(target), new UIntPtr(1), oldProtect, out ignored);
            FlushInstructionCache(pi.hProcess, new IntPtr(target), new UIntPtr(1));

            if (ResumeThread(pi.hThread) == 0xffffffff)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
            created = false;
            Console.WriteLine(
                "{\"pid\":" + pi.dwProcessId +
                ",\"port\":" + port +
                ",\"imageBase\":\"0x" + imageBase.ToString("x") + "\"" +
                ",\"fuseVersion\":" + fuseVersion +
                ",\"fuseAddress\":\"0x" + target.ToString("x") + "\"" +
                ",\"oldWire\":\"" + EscapeJson(oldWire) + "\"" +
                ",\"inspector\":\"127.0.0.1:" + port + "\"" +
                ",\"officialFileModified\":false}");
            return 0;
        }
        catch (Exception error)
        {
            if (created && pi.hProcess != IntPtr.Zero) TerminateProcess(pi.hProcess, 1);
            Console.Error.WriteLine(error.ToString());
            return 1;
        }
        finally
        {
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
        }
    }
}
