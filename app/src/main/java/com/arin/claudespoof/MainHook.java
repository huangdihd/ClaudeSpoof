package com.arin.claudespoof;

import android.content.Context;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.LocaleList;

import java.util.Locale;
import java.util.TimeZone;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XSharedPreferences;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

/**
 * Claude (com.anthropic.claude) 时区 / 语言伪装。
 *
 * 逆向依据（版本 1.261104.19）：
 *  - 聊天发送请求 SendChannelMessageRequest 带 sender_timezone 字段；
 *  - 时区提供器 defpackage.ts0：getID() 与 getOffset() 均来自 java.util.TimeZone.getDefault()；
 *  - 其接口 defpackage.neg 的 kotlinx 时区对象走 java.time.ZoneId.systemDefault()；
 *  - 语言走 Locale / LocaleList / Configuration / ICU。
 *
 * v1.2：
 *  - 配置双通道：XSharedPreferences + ContentProvider 互备，读取成功会打来源日志；
 *  - 语言补充 createConfigurationContext 与 per-app 语言 API 两条路径；
 *  - 配置值变化时打日志，便于排查。
 */
public class MainHook implements IXposedHookLoadPackage {

    private static final String TAG = "ClaudeSpoof";
    private static final long RELOAD_INTERVAL_MS = 3000;
    private static final Uri CONFIG_URI = Uri.parse("content://com.arin.claudespoof.config/config");

    private ClassLoader appClassLoader;
    private XSharedPreferences prefs;
    private Context appContext;
    private long lastReload;

    private volatile boolean enabled = SpoofConfig.ENABLED;
    private volatile String tzId = SpoofConfig.TIMEZONE_ID;
    private volatile String langTag = SpoofConfig.LANGUAGE_TAG;
    private volatile Locale spoofLocale = Locale.forLanguageTag(SpoofConfig.LANGUAGE_TAG);
    private volatile TimeZone spoofTz = TimeZone.getTimeZone(SpoofConfig.TIMEZONE_ID);

    private String lastLogSignature = "";
    private final java.util.HashMap<String, Integer> dbgCounts = new java.util.HashMap<>();

    private void debugLocales(XC_MethodHook.MethodHookParam param) {
        int n = dbg("cfg.getLocales");
        if (n <= 2) log("debug cfg.getLocales -> " + param.getResult());
        if (n == 1) {
            StringBuilder sb = new StringBuilder("debug stack:");
            StackTraceElement[] st = new Throwable().getStackTrace();
            for (int i = 0; i < st.length && i < 14; i++) {
                sb.append("\n  ").append(st[i].getClassName()).append('.').append(st[i].getMethodName());
            }
            log(sb.toString());
        }
    }

    private int dbg(String key) {
        Integer v = dbgCounts.get(key);
        int n = v == null ? 1 : v + 1;
        dbgCounts.put(key, n);
        return n;
    }

    @Override
    public void handleLoadPackage(XC_LoadPackage.LoadPackageParam lpparam) {
        if (!SpoofConfig.TARGET_PACKAGE.equals(lpparam.packageName)) return;

        appClassLoader = lpparam.classLoader;
        refreshConfig(true);
        log("active in process " + lpparam.processName + " tz=" + tzId + " lang=" + langTag);

        hookJavaTimeZone();
        hookZoneId();
        hookLocale();
        hookLocaleList();
        hookConfiguration();
        hookConfigurationContext();
        hookConfigGetLocales();
        hookPerAppLocales();
        hookIcu();
        hookSystemProperties();
    }

    /** 双通道读取配置；任一通道成功即采用，值变化时打日志 */
    private synchronized void refreshConfig(boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - lastReload < RELOAD_INTERVAL_MS) return;
        lastReload = now;

        Boolean en = null;
        String tz = null, lang = null, source = null;

        // 通道一：XSharedPreferences
        try {
            if (prefs == null) {
                prefs = new XSharedPreferences(SpoofConfig.MODULE_PACKAGE, SpoofConfig.PREFS_NAME);
            }
            prefs.reload();
            en = prefs.getBoolean(SpoofConfig.KEY_ENABLED, SpoofConfig.ENABLED);
            tz = prefs.getString(SpoofConfig.KEY_TIMEZONE, SpoofConfig.TIMEZONE_ID);
            lang = prefs.getString(SpoofConfig.KEY_LANGUAGE, SpoofConfig.LANGUAGE_TAG);
            source = "xsp";
        } catch (Throwable ignored) {
        }

        // 通道二：ContentProvider（通道一失败时）
        if (source == null) {
            Cursor c = null;
            try {
                if (appContext == null) {
                    Class<?> at = Class.forName("android.app.ActivityThread");
                    appContext = (Context) at.getMethod("currentApplication").invoke(null);
                }
                if (appContext != null) {
                    c = appContext.getContentResolver().query(CONFIG_URI, null, null, null, null);
                    if (c != null && c.moveToFirst()) {
                        en = c.getInt(0) == 1;
                        tz = c.getString(1);
                        lang = c.getString(2);
                        source = "provider";
                    }
                }
            } catch (Throwable ignored) {
            } finally {
                if (c != null) try { c.close(); } catch (Throwable ignored) {
                }
            }
        }

        if (source == null) {
            logOnce("config-read-failed", "config read failed on both channels, keep tz="
                    + tzId + " lang=" + langTag);
            return;
        }

        if (en != null) enabled = en;
        if (tz != null && !tz.isEmpty()) tzId = tz;
        if (lang != null && !lang.isEmpty()) langTag = lang;
        spoofLocale = Locale.forLanguageTag(langTag);
        spoofTz = TimeZone.getTimeZone(tzId);

        logOnce(source + "|" + enabled + "|" + tzId + "|" + langTag,
                "config <- " + source + ": enabled=" + enabled + " tz=" + tzId + " lang=" + langTag);
    }

    private void logOnce(String signature, String msg) {
        if (signature.equals(lastLogSignature)) return;
        lastLogSignature = signature;
        log(msg);
    }

    private void hookJavaTimeZone() {
        safe("TimeZone.getDefault", new Runnable() {
            @Override
            public void run() {
                XposedHelpers.findAndHookMethod(TimeZone.class, "getDefault", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        refreshConfig(false);
                        if (enabled) param.setResult(spoofTz);
                    }
                });
            }
        });
    }

    private void hookZoneId() {
        if (Build.VERSION.SDK_INT < 26) return;
        safe("ZoneId.systemDefault", new Runnable() {
            @Override
            public void run() {
                XposedHelpers.findAndHookMethod("java.time.ZoneId", null, "systemDefault", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        refreshConfig(false);
                        if (enabled) param.setResult(java.time.ZoneId.of(tzId));
                    }
                });
            }
        });
    }

    private void hookLocale() {
        safe("Locale.getDefault", new Runnable() {
            @Override
            public void run() {
                XC_MethodHook hook = new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        refreshConfig(false);
                        if (enabled) param.setResult(spoofLocale);
                    }
                };
                XposedHelpers.findAndHookMethod(Locale.class, "getDefault", hook);
                XposedHelpers.findAndHookMethod(Locale.class, "getDefault", Locale.Category.class, hook);
            }
        });
    }

    private void hookLocaleList() {
        safe("LocaleList.getDefault", new Runnable() {
            @Override
            public void run() {
                XC_MethodHook hook = new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        refreshConfig(false);
                        if (enabled) param.setResult(new LocaleList(spoofLocale));
                    }
                };
                XposedHelpers.findAndHookMethod(LocaleList.class, "getDefault", hook);
                XposedHelpers.findAndHookMethod(LocaleList.class, "getAdjustedDefault", hook);
            }
        });
    }

    private void hookConfiguration() {
        safe("Configuration", new Runnable() {
            @Override
            public void run() {
                XposedHelpers.findAndHookMethod(Resources.class, "getConfiguration", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        refreshConfig(false);
                        if (enabled) applyConfig((Configuration) param.getResult());
                    }
                });
            }
        });
    }

    /** per-app 语言常见路径：AppCompat/系统会 createConfigurationContext 覆盖区域设置 */
    private void hookConfigurationContext() {
        safe("createConfigurationContext", new Runnable() {
            @Override
            public void run() {
                Class<?> ci = cls("android.content.ContextImpl");
                XposedHelpers.findAndHookMethod(ci, "createConfigurationContext", Configuration.class,
                        new XC_MethodHook() {
                            @Override
                            protected void beforeHookedMethod(MethodHookParam param) {
                                refreshConfig(false);
                                if (enabled && param.args.length > 0) {
                                    applyConfig((Configuration) param.args[0]);
                                }
                            }
                        });
            }
        });
    }

    /** 直接拦 Configuration.getLocales，任何 Configuration 对象都返回伪装语言 */
    private void hookConfigGetLocales() {
        safe("Configuration.getLocales", new Runnable() {
            @Override
            public void run() {
                XposedHelpers.findAndHookMethod(Configuration.class, "getLocales", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        refreshConfig(false);
                        if (!enabled) return;
                        param.setResult(new LocaleList(spoofLocale));
                        debugLocales(param);
                    }
                });
            }
        });
    }

    /** Android 13+ per-app 语言 & AndroidX AppCompat 存储的应用语言 */
    private void hookPerAppLocales() {
        safe("LocaleManager", new Runnable() {
            @Override
            public void run() {
                if (Build.VERSION.SDK_INT < 33) return;
                Class<?> lm = cls("android.app.LocaleManager");
                XC_MethodHook hook = new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        refreshConfig(false);
                        if (enabled) param.setResult(new LocaleList(spoofLocale));
                    }
                };
                XposedHelpers.findAndHookMethod(lm, "getApplicationLocales", hook);
                XposedHelpers.findAndHookMethod(lm, "getSystemLocales", hook);
            }
        });
        safe("AppCompatDelegate", new Runnable() {
            @Override
            public void run() {
                Class<?> acd = XposedHelpers.findClassIfExists(
                        "androidx.appcompat.app.AppCompatDelegate", appClassLoader);
                if (acd == null) return;
                XposedHelpers.findAndHookMethod(acd, "getApplicationLocales", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        refreshConfig(false);
                        if (!enabled) return;
                        try {
                            Class<?> llc = XposedHelpers.findClassIfExists(
                                    "androidx.core.os.LocaleListCompat", appClassLoader);
                            if (llc != null) {
                                Object list = llc.getMethod("create", Locale[].class)
                                        .invoke(null, (Object) new Locale[]{spoofLocale});
                                param.setResult(list);
                            }
                        } catch (Throwable ignored) {
                        }
                    }
                });
            }
        });
    }

    private void applyConfig(Configuration c) {
        if (c == null) return;
        try {
            c.setLocales(new LocaleList(spoofLocale));
        } catch (Throwable ignored) {
        }
        try {
            XposedHelpers.setObjectField(c, "locale", spoofLocale);
        } catch (Throwable ignored) {
        }
    }

    private void hookIcu() {
        safe("icu.TimeZone", new Runnable() {
            @Override
            public void run() {
                XposedHelpers.findAndHookMethod("android.icu.util.TimeZone", null, "getDefault", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        refreshConfig(false);
                        if (enabled) {
                            param.setResult(android.icu.util.TimeZone.getTimeZone(tzId));
                        }
                    }
                });
            }
        });
        safe("icu.ULocale", new Runnable() {
            @Override
            public void run() {
                XposedHelpers.findAndHookMethod("android.icu.util.ULocale", null, "getDefault", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        refreshConfig(false);
                        if (enabled) {
                            param.setResult(android.icu.util.ULocale.forLocale(spoofLocale));
                        }
                    }
                });
            }
        });
    }

    private void hookSystemProperties() {
        safe("SystemProperties", new Runnable() {
            @Override
            public void run() {
                Class<?> sp = XposedHelpers.findClassIfExists("android.os.SystemProperties", null);
                if (sp == null) return;
                XposedBridge.hookAllMethods(sp, "get", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        refreshConfig(false);
                        if (enabled && param.args.length > 0
                                && "persist.sys.timezone".equals(param.args[0])) {
                            param.setResult(tzId);
                        }
                    }
                });
            }
        });
    }

    private static Class<?> cls(String name) {
        try {
            return Class.forName(name);
        } catch (Throwable t) {
            throw new RuntimeException(t);
        }
    }

    private void safe(String what, Runnable r) {
        try {
            r.run();
        } catch (Throwable t) {
            log("hook failed [" + what + "]: " + t);
        }
    }

    private void log(String msg) {
        XposedBridge.log(TAG + ": " + msg);
    }
}
