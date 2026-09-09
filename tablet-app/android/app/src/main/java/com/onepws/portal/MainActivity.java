package com.onepws.portal;

import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends BridgeActivity {

    // Must match server.url in capacitor.config.json. The backend serves
    // /tablet/latest.json and the APK from its static root.
    private static final String PORTAL_URL = "https://onepws-portal-207920932496.asia-south1.run.app";
    private static final String UPDATE_APK_NAME = "onepws-portal-update.apk";

    private static boolean updateCheckDone = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!updateCheckDone) {
            updateCheckDone = true;
            new Thread(this::checkForUpdate).start();
        }
    }

    // ---- 1. Check /tablet/latest.json for a newer versionCode --------------
    private void checkForUpdate() {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(PORTAL_URL + "/tablet/latest.json").openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
            StringBuilder body = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) body.append(line);
            reader.close();

            JSONObject json = new JSONObject(body.toString());
            int latestCode = json.getInt("versionCode");
            String latestName = json.optString("versionName", String.valueOf(latestCode));
            String url = json.getString("url");
            String apkUrl = url.startsWith("http") ? url : PORTAL_URL + url;

            @SuppressWarnings("deprecation")
            int installedCode = getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;

            if (latestCode > installedCode) {
                runOnUiThread(() -> promptUpdate(latestName, apkUrl));
            }
        } catch (Exception ignored) {
            // Offline or server unreachable — the portal itself will show its
            // own offline page; never block startup on the update check.
        }
    }

    // ---- 2. Ask the operator ----------------------------------------------
    private void promptUpdate(String versionName, String apkUrl) {
        if (isFinishing()) return;
        new AlertDialog.Builder(this)
                .setTitle("App update available")
                .setMessage("Version " + versionName + " of the ONEPWS Portal app is available. Download and install now?")
                .setPositiveButton("Update now", (d, w) -> startDownload(apkUrl))
                .setNegativeButton("Later", null)
                .setCancelable(true)
                .show();
    }

    // ---- 3. Download via DownloadManager, poll until done ------------------
    private void startDownload(String apkUrl) {
        File dest = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), UPDATE_APK_NAME);
        if (dest.exists()) dest.delete();

        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(apkUrl))
                .setTitle("ONEPWS Portal update")
                .setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, UPDATE_APK_NAME)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
        long downloadId = dm.enqueue(req);
        Toast.makeText(this, "Downloading update…", Toast.LENGTH_SHORT).show();
        pollDownload(dm, downloadId, dest, 0);
    }

    private void pollDownload(DownloadManager dm, long id, File dest, int attempts) {
        if (attempts > 300) return; // give up after ~5 minutes
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            Cursor c = dm.query(new DownloadManager.Query().setFilterById(id));
            int status = -1;
            if (c != null && c.moveToFirst()) {
                status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                c.close();
            }
            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                installApk(dest);
            } else if (status == DownloadManager.STATUS_FAILED) {
                Toast.makeText(this, "Update download failed — try again later.", Toast.LENGTH_LONG).show();
            } else {
                pollDownload(dm, id, dest, attempts + 1);
            }
        }, 1000);
    }

    // ---- 4. Hand the APK to the package installer --------------------------
    private void installApk(File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, "Could not start installer: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }
}
