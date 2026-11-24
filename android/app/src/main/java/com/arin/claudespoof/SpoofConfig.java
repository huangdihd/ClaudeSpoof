package com.arin.claudespoof;

/**
 * 常量与默认配置。
 * 运行时配置在模块 App 界面里修改，经 SharedPreferences 传递给 Claude 进程，
 * 这里的值仅作为首次启动 / 读取失败时的兜底默认。
 */
public final class SpoofConfig {

    /** 目标包名，不要改 */
    public static final String TARGET_PACKAGE = "com.anthropic.claude";

    /** 模块自身包名（XSharedPreferences 读取用） */
    public static final String MODULE_PACKAGE = "com.arin.claudespoof";

    /** 与设置界面共用的偏好文件名与键名 */
    public static final String PREFS_NAME = "config";
    public static final String KEY_ENABLED = "enabled";
    public static final String KEY_TIMEZONE = "timezone";
    public static final String KEY_LANGUAGE = "language";

    /** v1.5：运营商 / SIM 伪装（数据来源：对 Claude 1.261109.19 的静态分析） */
    public static final String KEY_COUNTRY = "country";
    public static final String KEY_CARRIER_NAME = "carrier_name";
    public static final String KEY_MCCMNC = "mccmnc";
    public static final String KEY_CARRIER_ID = "carrier_id";

    /** 兜底默认值（美东人设 + Verizon） */
    public static final boolean ENABLED = true;
    public static final String TIMEZONE_ID = "America/New_York";
    public static final String LANGUAGE_TAG = "en-US";

    /** 兜底运营商（Verizon Wireless，carrierId 取自 AOSP carrier_list） */
    public static final String COUNTRY = "US";
    public static final String CARRIER_NAME = "Verizon Wireless";
    public static final String MCCMNC = "311480";
    public static final int CARRIER_ID = 1839;

    private SpoofConfig() {
    }
}
