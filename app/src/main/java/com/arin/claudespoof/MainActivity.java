package com.arin.claudespoof;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.materialswitch.MaterialSwitch;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;

import java.util.Arrays;
import java.util.Locale;
import java.util.TimeZone;

/** Material 3 设置界面：改时区 / 语言 / 开关，保存后约 5 秒内在 Claude 进程生效 */
public class MainActivity extends AppCompatActivity {

    private SharedPreferences prefs;
    private MaterialSwitch enableSwitch;
    private TextInputEditText tzInput;
    private TextInputEditText langInput;
    private TextInputLayout tzLayout;
    private TextInputLayout langLayout;

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

        enableSwitch.setChecked(prefs.getBoolean(SpoofConfig.KEY_ENABLED, SpoofConfig.ENABLED));
        tzInput.setText(prefs.getString(SpoofConfig.KEY_TIMEZONE, SpoofConfig.TIMEZONE_ID));
        langInput.setText(prefs.getString(SpoofConfig.KEY_LANGUAGE, SpoofConfig.LANGUAGE_TAG));

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

        tzLayout.setError(null);
        langLayout.setError(null);

        if (!Arrays.asList(TimeZone.getAvailableIDs()).contains(tz)) {
            tzLayout.setError("时区 ID 无效，请使用 IANA 格式，如 America/New_York");
            return;
        }
        Locale locale = Locale.forLanguageTag(lang);
        if (locale.getLanguage().isEmpty()) {
            langLayout.setError("语言标签无效，请使用 BCP-47 格式，如 en-US");
            return;
        }

        prefs.edit()
                .putBoolean(SpoofConfig.KEY_ENABLED, enableSwitch.isChecked())
                .putString(SpoofConfig.KEY_TIMEZONE, tz)
                .putString(SpoofConfig.KEY_LANGUAGE, lang)
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
