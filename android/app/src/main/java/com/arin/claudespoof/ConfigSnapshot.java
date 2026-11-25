package com.arin.claudespoof;

import android.os.Build;
import android.os.LocaleList;

import java.util.Locale;
import java.util.TimeZone;

/**
 * 不可变配置快照：在后台刷新时一次性构建并缓存所有派生对象，
 * 使高频系统 API Hook 回调热路径做到 0 锁、0 I/O、0 重复对象分配。
 */
final class ConfigSnapshot {

    final boolean enabled;
    final String tzId;
    final String langTag;
    final String countryUpper;
    final String countryLower;
    final String carrierName;
    final String mccMnc;
    final String mccStr;
    final String mncStr;
    final int mcc;
    final int mnc;
    final int carrierId;
    final String source;

    final Locale locale;
    final LocaleList localeList;
    final TimeZone timeZone;
    final Object zoneId; // java.time.ZoneId on API 26+
    final android.icu.util.TimeZone icuTimeZone;
    final android.icu.util.ULocale icuLocale;
    final String logSignature;

    ConfigSnapshot(boolean enabled, String tzId, String langTag,
                   String country, String carrierName, String mccMnc,
                   int carrierId, String source) {
        this.enabled = enabled;
        this.tzId = nonEmpty(tzId, SpoofConfig.TIMEZONE_ID);
        this.langTag = nonEmpty(langTag, SpoofConfig.LANGUAGE_TAG);
        String ctry = nonEmpty(country, SpoofConfig.COUNTRY);
        this.countryUpper = ctry.toUpperCase(Locale.ROOT);
        this.countryLower = ctry.toLowerCase(Locale.ROOT);
        this.carrierName = nonEmpty(carrierName, SpoofConfig.CARRIER_NAME);
        this.mccMnc = nonEmpty(mccMnc, SpoofConfig.MCCMNC);
        this.carrierId = carrierId;
        this.source = source == null ? "default" : source;

        String parsedMcc = "";
        String parsedMnc = "";
        int parsedMccInt = 0;
        int parsedMncInt = 0;
        if (this.mccMnc.length() >= 5 && this.mccMnc.matches("\\d{5,6}")) {
            parsedMcc = this.mccMnc.substring(0, 3);
            parsedMnc = this.mccMnc.substring(3);
            try {
                parsedMccInt = Integer.parseInt(parsedMcc);
                parsedMncInt = Integer.parseInt(parsedMnc);
            } catch (NumberFormatException ignored) {
            }
        }
        this.mccStr = parsedMcc;
        this.mncStr = parsedMnc;
        this.mcc = parsedMccInt;
        this.mnc = parsedMncInt;

        Locale builtLocale = Locale.forLanguageTag(this.langTag);
        if (builtLocale.getLanguage().isEmpty()) {
            builtLocale = Locale.forLanguageTag(SpoofConfig.LANGUAGE_TAG);
        }
        this.locale = builtLocale;
        this.localeList = new LocaleList(this.locale);
        this.timeZone = TimeZone.getTimeZone(this.tzId);

        Object z = null;
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                z = java.time.ZoneId.of(this.tzId);
            } catch (Throwable ignored) {
                z = this.timeZone.toZoneId();
            }
        }
        this.zoneId = z;

        this.icuTimeZone = android.icu.util.TimeZone.getTimeZone(this.tzId);
        this.icuLocale = android.icu.util.ULocale.forLocale(this.locale);
        this.logSignature = this.source + "|" + this.enabled + "|" + this.tzId + "|"
                + this.langTag + "|" + this.countryLower + "|" + this.carrierName + "|"
                + this.mccMnc + "|" + this.carrierId;
    }

    static ConfigSnapshot defaultSnapshot() {
        return new ConfigSnapshot(
                SpoofConfig.ENABLED,
                SpoofConfig.TIMEZONE_ID,
                SpoofConfig.LANGUAGE_TAG,
                SpoofConfig.COUNTRY,
                SpoofConfig.CARRIER_NAME,
                SpoofConfig.MCCMNC,
                SpoofConfig.CARRIER_ID,
                "default"
        );
    }

    private static String nonEmpty(String value, String fallback) {
        if (value == null) return fallback;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? fallback : trimmed;
    }
}
