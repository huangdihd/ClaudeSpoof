using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class MemoryFuseLauncher
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint PAGE_READWRITE = 0x04;
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

    private static int FindSentinel(IntPtr process, long imageBase, int imageSize)
    {
        const int chunkSize = 1024 * 1024;
        for (int offset = 0; offset < imageSize; offset += chunkSize)
        {
            int count = Math.Min(chunkSize + FuseSentinel.Length, imageSize - offset);
            byte[] data = ReadRemote(process, imageBase + offset, count);
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
        throw new Exception("Electron fuse sentinel was not found in the official process image");
    }

    public static int Main(string[] args)
    {
        if (args.Length != 2)
        {
            Console.Error.WriteLine("Usage: MemoryFuseLauncher.exe <official Claude.exe> <inspector port>");
            return 2;
        }
        string executable = Path.GetFullPath(args[0]);
        string port = args[1];
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        bool created = false;
        try
        {
            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            string command = "\"" + executable + "\" --inspect-brk=127.0.0.1:" + port;
            if (!CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false,
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

            int sentinelOffset = FindSentinel(pi.hProcess, imageBase, imageSize);
            byte[] fuseHeader = ReadRemote(pi.hProcess, imageBase + sentinelOffset + FuseSentinel.Length, 6);
            int wireLength = fuseHeader[1];
            if (wireLength <= 3) throw new Exception("Invalid Electron fuse wire length: " + wireLength);
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
            Console.WriteLine("{\"pid\":" + pi.dwProcessId + ",\"imageBase\":\"0x" + imageBase.ToString("x") +
                "\",\"fuseAddress\":\"0x" + target.ToString("x") + "\",\"oldWire\":\"" + oldWire +
                "\",\"inspector\":\"127.0.0.1:" + port + "\",\"officialFileModified\":false}");
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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushInstructionCache(IntPtr process, IntPtr baseAddress, UIntPtr size);
}
