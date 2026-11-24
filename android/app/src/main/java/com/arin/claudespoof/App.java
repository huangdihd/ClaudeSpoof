package com.arin.claudespoof;

import android.app.Application;

import com.google.android.material.color.DynamicColors;

/** 全局入口：Android 12+ 启用 Material You 动态取色 */
public class App extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        DynamicColors.applyToActivitiesIfAvailable(this);
    }
}
