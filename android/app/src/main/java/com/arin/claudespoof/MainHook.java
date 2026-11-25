package com.arin.claudespoof;

import android.content.Context;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.LocaleList;
import android.os.SystemClock;
import android.system.Os;
import android.telephony.SubscriptionInfo;
import android.telephony.TelephonyManager;

import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XSharedPreferences;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

/**
 * Claude (com.anthropic.claude) 时区 / 语言 / 运营商元数据伪装。
 *
 * v1.6 架构重构：
 *  - 不可变 ConfigSnapshot + volatile 无锁热路径 + 后台单线程异步刷新，彻底消除 UI 线程阻塞与锁竞争；
 *  - 修复 XSharedPreferences 无权限时假成功导致 ContentProvider 降级失效的 Bug；
 *  - 通过 Os.setenv("TZ", ...) 同步覆盖 native 层与 WebView/Chromium 时区；
 *  - 补全 TimeZone.getDefaultRef()、ULocale.getDefault(Category)、System.getProperty、
 *    TelephonyManager 双卡 slotIndex 重载、SubscriptionInfo 与 Configuration.mcc/mnc；
 *  - 运营商国家码遵循 Android 标准返回小写 ISO 码；不再原地篡改共享 Configuration 实例。
 */
public class MainHook implements IXposedHookLoadPackage {

    private static final String TAG = "ClaudeSpoof";
    private static final long RELOAD_INTERVAL_MS = 3000L;
    private static final Uri CONFIG_URI = Uri.parse("content://com.arin.claudespoof.config/config");

    private ClassLoader appClassLoader;
    private XSharedPreferences prefs;
    private volatile Context appContext;
    private volatile String originalNativeTz;
    private volatile boolean originalNativeTzCaptured = false;

    private volatile ConfigSnapshot current = ConfigSnapshot.defaultSnapshot();
    private volatile long lastReloadElapsed = 0L;
    private final AtomicBoolean refreshing = new AtomicBoolean(false);
    private volatile String lastLogSignature = "";

    private final ExecutorService reloadExecutor = Executors.newSingleThreadExecutor(new ThreadFactory() {
        @Override
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "ClaudeSpoof-ConfigReload");
            t.setDaemon(true);
            return t;
        }
    });

    @Override
    public void handleLoadPackage(XC_LoadPackage.LoadPackageParam lpparam) {
        if (!SpoofConfig.TARGET_PACKAGE.equals(lpparam.packageName)) return;

        appClassLoader = lpparam.classLoader;
        captureOriginalNativeTz();
        reloadConfigSync();

        ConfigSnapshot snap = current;
        log("active in process " + lpparam.processName
                + " enabled=" + snap.enabled
                + " tz=" + snap.tzId
                + " lang=" + snap.langTag
                + " country=" + snap.countryLower);

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
        hookSystemGetProperty();
        hookTelephonyManager();
        hookSubscriptionInfo();
    }

    /** 热路径完全无锁：直接返回当前不可变快照，到期后异步触发后台刷新 */
    private ConfigSnapshot getConfig() {
        long now = SystemClock.elapsedRealtime();
        if (now - lastReloadElapsed >= RELOAD_INTERVAL_MS
                && refreshing.compareAndSet(false, true)) {
            lastReloadElapsed = now;
            try {
                reloadExecutor.execute(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            reloadConfigSync();
                        } finally {
                            refreshing.set(false);
                        }
                    }
                });
            } catch (Throwable ignored) {
                refreshing.set(false);
            }
        }
        return current;
    }

    private void captureOriginalNativeTz() {
        if (originalNativeTzCaptured) return;
        try {
            originalNativeTz = Os.getenv("TZ");
        } catch (Throwable ignored) {
        }
        originalNativeTzCaptured = true;
    }

    private void applyNativeTz(ConfigSnapshot snap) {
        try {
            if (snap.enabled) {
                Os.setenv("TZ", snap.tzId, true);
            } else if (originalNativeTz != null && !originalNativeTz.isEmpty()) {
                Os.setenv("TZ", originalNativeTz, true);
            } else {
                Os.unsetenv("TZ");
            }
        } catch (Throwable ignored) {
        }
    }

    /** 仅在初始化或后台单线程中执行，绝不阻塞 UI 线程或 Hook 调用方 */
    private void reloadConfigSync() {
        lastReloadElapsed = SystemClock.elapsedRealtime();

        Boolean en = null;
        String tz = null, lang = null, country = null, carrier = null, mcc = null, source = null;
        Integer cid = null;

        // 通道一：XSharedPreferences（校验文件真正可读且含有效键，避免无权限时假成功）
        try {
            if (prefs == null) {
                prefs = new XSharedPreferences(SpoofConfig.MODULE_PACKAGE, SpoofConfig.PREFS_NAME);
            }
            prefs.reload();
            if (prefs.getFile().canRead()) {
                Map<String, ?> all = prefs.getAll();
                if (all != null && !all.isEmpty()) {
                    en = prefs.getBoolean(SpoofConfig.KEY_ENABLED, SpoofConfig.ENABLED);
                    tz = prefs.getString(SpoofConfig.KEY_TIMEZONE, SpoofConfig.TIMEZONE_ID);
                    lang = prefs.getString(SpoofConfig.KEY_LANGUAGE, SpoofConfig.LANGUAGE_TAG);
                    country = prefs.getString(SpoofConfig.KEY_COUNTRY, SpoofConfig.COUNTRY);
                    carrier = prefs.getString(SpoofConfig.KEY_CARRIER_NAME, SpoofConfig.CARRIER_NAME);
                    mcc = prefs.getString(SpoofConfig.KEY_MCCMNC, SpoofConfig.MCCMNC);
                    cid = prefs.getInt(SpoofConfig.KEY_CARRIER_ID, SpoofConfig.CARRIER_ID);
                    source = "xsp";
                }
            }
        } catch (Throwable ignored) {
        }

        // 通道二：ContentProvider（通道一未读到有效数据时回退）
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
                        country = c.getString(3);
                        carrier = c.getString(4);
                        mcc = c.getString(5);
                        cid = c.getInt(6);
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
            ConfigSnapshot prev = current;
            applyNativeTz(prev);
            logOnce("config-read-failed|" + prev.tzId + "|" + prev.langTag,
                    "config read failed on both channels, keep tz=" + prev.tzId + " lang=" + prev.langTag);
            return;
        }

        ConfigSnapshot next = new ConfigSnapshot(
                en != null ? en : SpoofConfig.ENABLED,
                tz, lang, country, carrier, mcc,
                cid != null ? cid : SpoofConfig.CARRIER_ID,
                source
        );
        current = next;
        applyNativeTz(next);

        logOnce(next.logSignature,
                "config <- " + next.source
                        + ": enabled=" + next.enabled
                        + " tz=" + next.tzId
                        + " lang=" + next.langTag
                        + " country=" + next.countryLower
                        + " carrier=" + next.carrierName
                        + " mccmnc=" + next.mccMnc
                        + " carrierId=" + next.carrierId);
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
                XC_MethodHook hook = new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled) param.setResult(snap.timeZone.clone());
                    }
                };
                XposedHelpers.findAndHookMethod(TimeZone.class, "getDefault", hook);
                // AOSP Calendar.getInstance() / SimpleDateFormat 直接调 getDefaultRef()
                try {
                    XposedHelpers.findAndHookMethod(TimeZone.class, "getDefaultRef", new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            ConfigSnapshot snap = getConfig();
                            if (snap.enabled) param.setResult(snap.timeZone);
                        }
                    });
                } catch (Throwable ignored) {
                }
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
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled && snap.zoneId != null) {
                            param.setResult(snap.zoneId);
                        }
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
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled) param.setResult(snap.locale);
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
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled) param.setResult(snap.localeList);
                    }
                };
                XposedHelpers.findAndHookMethod(LocaleList.class, "getDefault", hook);
                XposedHelpers.findAndHookMethod(LocaleList.class, "getAdjustedDefault", hook);
            }
        });
    }

    private void hookConfiguration() {
        safe("Resources.getConfiguration", new Runnable() {
            @Override
            public void run() {
                XposedHelpers.findAndHookMethod(Resources.class, "getConfiguration", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        ConfigSnapshot snap = getConfig();
                        if (!snap.enabled) return;
                        Configuration orig = (Configuration) param.getResult();
                        if (orig == null) return;
                        // 返回副本而非原地修改系统共享 Configuration，避免关闭伪装后残留脏值
                        Configuration copy = new Configuration(orig);
                        applyConfig(copy, snap);
                        param.setResult(copy);
                    }
                });
            }
        });
    }

    private void hookConfigurationContext() {
        safe("createConfigurationContext", new Runnable() {
            @Override
            public void run() {
                Class<?> ci = cls("android.content.ContextImpl");
                XposedHelpers.findAndHookMethod(ci, "createConfigurationContext", Configuration.class,
                        new XC_MethodHook() {
                            @Override
                            protected void beforeHookedMethod(MethodHookParam param) {
                                ConfigSnapshot snap = getConfig();
                                if (snap.enabled && param.args.length > 0 && param.args[0] instanceof Configuration) {
                                    Configuration copy = new Configuration((Configuration) param.args[0]);
                                    applyConfig(copy, snap);
                                    param.args[0] = copy;
                                }
                            }
                        });
            }
        });
    }

    private void hookConfigGetLocales() {
        safe("Configuration.getLocales", new Runnable() {
            @Override
            public void run() {
                XposedHelpers.findAndHookMethod(Configuration.class, "getLocales", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled) param.setResult(snap.localeList);
                    }
                });
            }
        });
    }

    private void hookPerAppLocales() {
        safe("LocaleManager", new Runnable() {
            @Override
            public void run() {
                if (Build.VERSION.SDK_INT < 33) return;
                Class<?> lm = cls("android.app.LocaleManager");
                XC_MethodHook hook = new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled) param.setResult(snap.localeList);
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
                        ConfigSnapshot snap = getConfig();
                        if (!snap.enabled) return;
                        try {
                            Class<?> llc = XposedHelpers.findClassIfExists(
                                    "androidx.core.os.LocaleListCompat", appClassLoader);
                            if (llc != null) {
                                Object list = llc.getMethod("create", Locale[].class)
                                        .invoke(null, (Object) new Locale[]{snap.locale});
                                param.setResult(list);
                            }
                        } catch (Throwable ignored) {
                        }
                    }
                });
            }
        });
    }

    private void applyConfig(Configuration c, ConfigSnapshot snap) {
        if (c == null) return;
        try {
            c.setLocales(snap.localeList);
        } catch (Throwable ignored) {
        }
        try {
            XposedHelpers.setObjectField(c, "locale", snap.locale);
        } catch (Throwable ignored) {
        }
        if (snap.mcc > 0) c.mcc = snap.mcc;
        if (snap.mnc > 0) c.mnc = snap.mnc;
    }

    private void hookIcu() {
        safe("icu.TimeZone", new Runnable() {
            @Override
            public void run() {
                XposedHelpers.findAndHookMethod("android.icu.util.TimeZone", null, "getDefault", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled) param.setResult(snap.icuTimeZone.clone());
                    }
                });
            }
        });
        safe("icu.ULocale", new Runnable() {
            @Override
            public void run() {
                Class<?> uLocaleClass = XposedHelpers.findClassIfExists("android.icu.util.ULocale", null);
                if (uLocaleClass == null) return;
                XposedBridge.hookAllMethods(uLocaleClass, "getDefault", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled) param.setResult(snap.icuLocale);
                    }
                });
            }
        });
    }

    private void hookTelephonyManager() {
        safe("TelephonyManager", new Runnable() {
            @Override
            public void run() {
                XC_MethodHook isoHook = new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        ConfigSnapshot snap = getConfig();
                        // Android 标准 API 返回小写 ISO-3166 alpha-2 国家码（如 "us", "gb"）
                        if (snap.enabled) param.setResult(snap.countryLower);
                    }
                };
                XC_MethodHook operatorHook = new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled) param.setResult(snap.mccMnc);
                    }
                };
                XC_MethodHook carrierNameHook = new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled) param.setResult(snap.carrierName);
                    }
                };
                // 使用 hookAllMethods 同时覆盖 0 参和双卡 int slotIndex/subId 重载
                XposedBridge.hookAllMethods(TelephonyManager.class, "getSimCountryIso", isoHook);
                XposedBridge.hookAllMethods(TelephonyManager.class, "getNetworkCountryIso", isoHook);
                XposedBridge.hookAllMethods(TelephonyManager.class, "getSimOperator", operatorHook);
                XposedBridge.hookAllMethods(TelephonyManager.class, "getNetworkOperator", operatorHook);
                XposedBridge.hookAllMethods(TelephonyManager.class, "getSimOperatorName", carrierNameHook);
                XposedBridge.hookAllMethods(TelephonyManager.class, "getNetworkOperatorName", carrierNameHook);
                if (Build.VERSION.SDK_INT >= 29) {
                    XposedBridge.hookAllMethods(TelephonyManager.class, "getSimCarrierId", new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            ConfigSnapshot snap = getConfig();
                            if (snap.enabled) param.setResult(snap.carrierId);
                        }
                    });
                    XposedBridge.hookAllMethods(TelephonyManager.class, "getSimCarrierIdName", carrierNameHook);
                }
            }
        });
    }

    private void hookSubscriptionInfo() {
        safe("SubscriptionInfo", new Runnable() {
            @Override
            public void run() {
                XposedBridge.hookAllMethods(SubscriptionInfo.class, "getCountryIso", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled) param.setResult(snap.countryLower);
                    }
                });
                XC_MethodHook nameHook = new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled) param.setResult(snap.carrierName);
                    }
                };
                XposedBridge.hookAllMethods(SubscriptionInfo.class, "getCarrierName", nameHook);
                XposedBridge.hookAllMethods(SubscriptionInfo.class, "getDisplayName", nameHook);
                XposedBridge.hookAllMethods(SubscriptionInfo.class, "getMcc", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled && snap.mcc > 0) param.setResult(snap.mcc);
                    }
                });
                XposedBridge.hookAllMethods(SubscriptionInfo.class, "getMnc", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled && snap.mnc > 0) param.setResult(snap.mnc);
                    }
                });
                if (Build.VERSION.SDK_INT >= 29) {
                    XposedBridge.hookAllMethods(SubscriptionInfo.class, "getMccString", new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            ConfigSnapshot snap = getConfig();
                            if (snap.enabled && !snap.mccStr.isEmpty()) param.setResult(snap.mccStr);
                        }
                    });
                    XposedBridge.hookAllMethods(SubscriptionInfo.class, "getMncString", new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            ConfigSnapshot snap = getConfig();
                            if (snap.enabled && !snap.mncStr.isEmpty()) param.setResult(snap.mncStr);
                        }
                    });
                    XposedBridge.hookAllMethods(SubscriptionInfo.class, "getCarrierId", new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            ConfigSnapshot snap = getConfig();
                            if (snap.enabled) param.setResult(snap.carrierId);
                        }
                    });
                }
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
                        if (param.args.length == 0 || !("persist.sys.timezone".equals(param.args[0]))) return;
                        ConfigSnapshot snap = getConfig();
                        if (snap.enabled) param.setResult(snap.tzId);
                    }
                });
            }
        });
    }

    private void hookSystemGetProperty() {
        safe("System.getProperty", new Runnable() {
            @Override
            public void run() {
                XposedBridge.hookAllMethods(System.class, "getProperty", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        if (param.args.length == 0 || !(param.args[0] instanceof String)) return;
                        String key = (String) param.args[0];
                        if ("user.timezone".equals(key)) {
                            ConfigSnapshot snap = getConfig();
                            if (snap.enabled) param.setResult(snap.tzId);
                        } else if ("user.language".equals(key)) {
                            ConfigSnapshot snap = getConfig();
                            if (snap.enabled) param.setResult(snap.locale.getLanguage());
                        } else if ("user.country".equals(key) || "user.region".equals(key)) {
                            ConfigSnapshot snap = getConfig();
                            if (snap.enabled && !snap.locale.getCountry().isEmpty()) {
                                param.setResult(snap.locale.getCountry());
                            }
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
