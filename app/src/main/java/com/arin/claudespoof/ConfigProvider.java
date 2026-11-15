package com.arin.claudespoof;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;

/**
 * 配置读取的第二通道：Claude 进程通过 content://com.arin.claudespoof.config/config
 * 查询当前配置，直接读模块 App 的 SharedPreferences，总是实时值。
 *
 * v1.5 起列扩展为 enabled/timezone/language/country/carrier_name/mccmnc/carrier_id，
 * 模块与 Hook 同版本发布，按固定索引读取。
 */
public class ConfigProvider extends ContentProvider {

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        SharedPreferences sp = getContext().getSharedPreferences(
                SpoofConfig.PREFS_NAME, android.content.Context.MODE_PRIVATE);
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
