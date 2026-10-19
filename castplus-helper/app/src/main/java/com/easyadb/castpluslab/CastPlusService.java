package com.easyadb.castpluslab;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Log;

/**
 * A test display, NOT a Huawei Cast+ implementation or a Miracast receiver.
 * The hypothesis is that the OEM's display name/type check accepts it.
 */
public final class CastPlusService extends Service {
    private static final String TAG = "EasyADBCastLab";
    private static final String CHANNEL = "castplus-lab";
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread drainThread;

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "EasyADB Cast+ 实验",
                    NotificationManager.IMPORTANCE_LOW));
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        startForeground(42021, builder.setSmallIcon(android.R.drawable.ic_menu_share)
                .setContentTitle("EasyADB Cast+ 显示器实验")
                .setContentText("测试虚拟屏已启动；可从电脑模式实验停止").build());
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        releaseDisplay();
        try {
            drainThread = new HandlerThread("castplus-frame-drain");
            drainThread.start();
            reader = ImageReader.newInstance(1920, 1080, PixelFormat.RGBA_8888, 2);
            reader.setOnImageAvailableListener(source -> {
                Image image = null;
                try { image = source.acquireLatestImage(); }
                catch (RuntimeException error) { Log.w(TAG, "Frame drain", error); }
                finally { if (image != null) image.close(); }
            }, new Handler(drainThread.getLooper()));
            DisplayManager dm = (DisplayManager) getSystemService(DISPLAY_SERVICE);
            int displayFlags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC
                    | DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION
                    | DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY;
            display = dm.createVirtualDisplay("CastPlusDisplay", 1920, 1080, 240,
                    reader.getSurface(), displayFlags);
            if (display == null) throw new IllegalStateException("createVirtualDisplay returned null");
            Log.i(TAG, "created CastPlusDisplay displayId=" + display.getDisplay().getDisplayId());
        } catch (RuntimeException failure) {
            Log.e(TAG, "Could not create CastPlusDisplay", failure);
            releaseDisplay();
            stopSelf(startId);
        }
        return START_NOT_STICKY;
    }

    private void releaseDisplay() {
        if (display != null) { display.release(); display = null; }
        if (reader != null) { reader.close(); reader = null; }
        if (drainThread != null) { drainThread.quitSafely(); drainThread = null; }
    }

    @Override public void onDestroy() { releaseDisplay(); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
