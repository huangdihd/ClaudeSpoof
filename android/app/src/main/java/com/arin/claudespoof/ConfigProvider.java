package com.arin.claudespoof;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Binder;

/**
 * 配置读取的第二通道（仅在 XSharedPreferences 不可读时回退使用）。
 *
 * v1.6 安全加固：通过 Binder.getCallingUid() 严格白名单校验，
 * 仅允许目标应用（com.anthropic.claude）与模块自身读取，避免暴露给任意第三方 App 或探测脚本。
 */
public class ConfigProvider extends ContentProvider {

    @Override
    public boolean onCreate() {
        return true;
    }

    private boolean isAuthorizedCaller(Context ctx) {
        if (ctx == null) return false;
        int callingUid = Binder.getCallingUid();
        if (callingUid == android.os.Process.myUid()) return true;
        PackageManager pm = ctx.getPackageManager();
        if (pm == null) return false;
        String[] pkgs = pm.getPackagesForUid(callingUid);
        if (pkgs == null) return false;
        for (String pkg : pkgs) {
            if (SpoofConfig.TARGET_PACKAGE.equals(pkg) || SpoofConfig.MODULE_PACKAGE.equals(pkg)) {
                return true;
            }
        }
        return false;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        Context ctx = getContext();
        if (!isAuthorizedCaller(ctx)) {
            return null;
        }
        SharedPreferences sp = ctx.getSharedPreferences(
                SpoofConfig.PREFS_NAME, Context.MODE_PRIVATE);
        MatrixCursor cursor = new MatrixCursor(new String[]{
                "enabled", "timezone", "language",
                "country", "carrier_name", "mccmnc", "carrier_id"});
        cursor.addRow(new Object[]{
                sp.getBoolean(SpoofConfig.KEY_ENABLED, SpoofConfig.ENABLED) ? 1 : 0,
                sp.getString(SpoofConfig.KEY_TIMEZONE, SpoofConfig.TIMEZONE_ID),
                sp.getString(SpoofConfig.KEY_LANGUAGE, SpoofConfig.LANGUAGE_TAG),
                sp.getString(SpoofConfig.KEY_COUNTRY, SpoofConfig.COUNTRY),
                sp.getString(SpoofConfig.KEY_CARRIER_NAME, SpoofConfig.CARRIER_NAME),
                sp.getString(SpoofConfig.KEY_MCCMNC, SpoofConfig.MCCMNC),
                sp.getInt(SpoofConfig.KEY_CARRIER_ID, SpoofConfig.CARRIER_ID)});
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return "text/plain";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
