package com.arin.claudespoof;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.widget.AdapterView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.materialswitch.MaterialSwitch;
import com.google.android.material.textfield.MaterialAutoCompleteTextView;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;

import java.util.Arrays;
import java.util.Locale;
import java.util.TimeZone;

/** Material 3 设置界面：改时区 / 语言 / 运营商 / 开关，保存后约 5 秒内在 Claude 进程生效 */
public class MainActivity extends AppCompatActivity {

    /** 运营商预设：label|country|carrierName|mccmnc|carrierId（与 R.array.carrier_presets 顺序一致，0=自定义） */
    private static final String[][] PRESETS = {
            null, // 自定义
            {"US", "Verizon Wireless", "311480", "1839"},
            {"US", "T-Mobile", "310260", "1"},
            {"US", "AT&T", "310410", "1187"},
            {"JP", "docomo", "44010", "-1"},
            {"JP", "SoftBank", "44020", "-1"},
            {"GB", "EE", "23430", "2"},
            {"GB", "Vodafone", "23415", "28"},
            {"GB", "O2", "23410", "1492"},
            {"GB", "Three Mobile", "23420", "1505"},
    };

    private SharedPreferences prefs;
    private MaterialSwitch enableSwitch;
    private TextInputEditText tzInput;
    private TextInputEditText langInput;
    private TextInputLayout tzLayout;
    private TextInputLayout langLayout;
    private MaterialAutoCompleteTextView presetDropdown;
    private TextInputEditText countryInput;
    private TextInputEditText carrierInput;
    private TextInputEditText mccmncInput;
    private TextInputLayout countryLayout;
    private TextInputLayout mccmncLayout;
    private int pendingCarrierId = SpoofConfig.CARRIER_ID;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // LSPosed 允许模块使用 MODE_WORLD_READABLE（供 XSharedPreferences 通道读取）；
        // 不支持的环境回退 MODE_PRIVATE，此时由 ContentProvider 通道兜底。
        SharedPreferences sp;
        try {
            sp = getSharedPreferences(SpoofConfig.PREFS_NAME, MODE_PRIVATE | MODE_WORLD_READABLE);
        } catch (Throwable t) {
            sp = getSharedPreferences(SpoofConfig.PREFS_NAME, MODE_PRIVATE);
        }
        prefs = sp;

        enableSwitch = findViewById(R.id.enable_switch);
        tzInput = findViewById(R.id.tz_input);
        langInput = findViewById(R.id.lang_input);
        tzLayout = findViewById(R.id.tz_layout);
        langLayout = findViewById(R.id.lang_layout);
        presetDropdown = findViewById(R.id.preset_dropdown);
        countryInput = findViewById(R.id.country_input);
        carrierInput = findViewById(R.id.carrier_input);
        mccmncInput = findViewById(R.id.mccmnc_input);
        countryLayout = findViewById(R.id.country_layout);
        mccmncLayout = findViewById(R.id.mccmnc_layout);

        enableSwitch.setChecked(prefs.getBoolean(SpoofConfig.KEY_ENABLED, SpoofConfig.ENABLED));
        tzInput.setText(prefs.getString(SpoofConfig.KEY_TIMEZONE, SpoofConfig.TIMEZONE_ID));
        langInput.setText(prefs.getString(SpoofConfig.KEY_LANGUAGE, SpoofConfig.LANGUAGE_TAG));
        countryInput.setText(prefs.getString(SpoofConfig.KEY_COUNTRY, SpoofConfig.COUNTRY));
        carrierInput.setText(prefs.getString(SpoofConfig.KEY_CARRIER_NAME, SpoofConfig.CARRIER_NAME));
        mccmncInput.setText(prefs.getString(SpoofConfig.KEY_MCCMNC, SpoofConfig.MCCMNC));
        pendingCarrierId = prefs.getInt(SpoofConfig.KEY_CARRIER_ID, SpoofConfig.CARRIER_ID);

        presetDropdown.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override
            public void onItemClick(AdapterView<?> parent, View view, int position, long id) {
                if (position > 0 && position < PRESETS.length) {
                    String[] p = PRESETS[position];
                    countryInput.setText(p[0]);
                    carrierInput.setText(p[1]);
                    mccmncInput.setText(p[2]);
                    pendingCarrierId = Integer.parseInt(p[3]);
                } else {
                    pendingCarrierId = -1; // 自定义：carrierId 未知
                }
            }
        });

        findViewById(R.id.save_button).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                save();
            }
        });
    }

    private void save() {
        String tz = tzInput.getText() == null ? "" : tzInput.getText().toString().trim();
        String lang = langInput.getText() == null ? "" : langInput.getText().toString().trim();
        String country = countryInput.getText() == null ? "" : countryInput.getText().toString().trim().toUpperCase(Locale.ROOT);
        String carrier = carrierInput.getText() == null ? "" : carrierInput.getText().toString().trim();
        String mccmnc = mccmncInput.getText() == null ? "" : mccmncInput.getText().toString().trim();

        tzLayout.setError(null);
        langLayout.setError(null);
        countryLayout.setError(null);
        mccmncLayout.setError(null);

        if (!Arrays.asList(TimeZone.getAvailableIDs()).contains(tz)) {
            tzLayout.setError("时区 ID 无效，请使用 IANA 格式，如 America/New_York");
            return;
        }
        Locale locale = Locale.forLanguageTag(lang);
        if (locale.getLanguage().isEmpty()) {
            langLayout.setError("语言标签无效，请使用 BCP-47 格式，如 en-US");
            return;
        }
        if (!country.matches("[A-Z]{2}")) {
            countryLayout.setError("国家码无效，请使用两位 ISO 代码，如 US");
            return;
        }
        if (!mccmnc.matches("\\d{5,6}")) {
            mccmncLayout.setError("MCC/MNC 无效，请使用 5~6 位数字，如 311480");
            return;
        }
        if (carrier.isEmpty()) {
            toast("运营商名称不能为空");
            return;
        }

        prefs.edit()
                .putBoolean(SpoofConfig.KEY_ENABLED, enableSwitch.isChecked())
                .putString(SpoofConfig.KEY_TIMEZONE, tz)
                .putString(SpoofConfig.KEY_LANGUAGE, lang)
                .putString(SpoofConfig.KEY_COUNTRY, country)
                .putString(SpoofConfig.KEY_CARRIER_NAME, carrier)
                .putString(SpoofConfig.KEY_MCCMNC, mccmnc)
                .putInt(SpoofConfig.KEY_CARRIER_ID, pendingCarrierId)
                .apply();
        // 尽力让配置文件可被其他进程读取（XSharedPreferences 传统路径；SELinux 严格的环境走 Provider 通道）
        try {
            java.io.File dataDir = new java.io.File(getApplicationInfo().dataDir);
            java.io.File spDir = new java.io.File(dataDir, "shared_prefs");
            java.io.File f = new java.io.File(spDir, SpoofConfig.PREFS_NAME + ".xml");
            f.setReadable(true, false);
            spDir.setReadable(true, false);
            spDir.setExecutable(true, false);
            dataDir.setExecutable(true, false);
        } catch (Throwable ignored) {
        }
        toast("已保存，约 5 秒内生效（未生效则强杀 Claude 重开）");
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
    }
}
