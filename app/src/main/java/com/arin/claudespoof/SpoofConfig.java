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

    /** 兜底默认值 */
    public static final boolean ENABLED = true;
    public static final String TIMEZONE_ID = "America/New_York";
    public static final String LANGUAGE_TAG = "en-US";

    private SpoofConfig() {
    }
}
