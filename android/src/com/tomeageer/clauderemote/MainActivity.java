package com.tomeageer.clauderemote;

// Claude 远程（安卓）：一个薄壳，打开你自己中转服务器上的手机网页（和 iPhone 用 Safari 打开的是同一个页面）。
// 壳只补浏览器缺的几样：记住中转地址、页面里扫码要的摄像头权限、发图片 / 文件要的文件选择、返回键。
// 不写死任何地址：第一次打开先填中转地址（assets/setup.html），在首页按返回键可以更换。

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private static final String SETUP = "file:///android_asset/setup.html";
    private static final int REQ_FILE = 1;
    private static final int REQ_CAMERA = 2;

    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCb;
    private PermissionRequest pendingPerm;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("app", MODE_PRIVATE);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // 配对信息、主题都存在页面的 localStorage 里
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true); // 只用来打开自带的 setup.html
        s.setUserAgentString(s.getUserAgentString() + " ClaudeRemoteAndroid/1.0");
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "ClaudeRemoteApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                String relay = prefs.getString("relay", "");
                // 中转自己的页面在 App 里打开，别的链接交给系统浏览器
                if (u.toString().startsWith("file:///android_asset/") || (!relay.isEmpty() && sameOrigin(u, Uri.parse(relay)))) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError e) {
                if (!req.isForMainFrame()) return;
                String relay = prefs.getString("relay", "");
                v.loadUrl(SETUP + "?url=" + Uri.encode(relay) + "&error=" + Uri.encode("连不上 " + relay + "（" + e.getDescription() + "），检查地址和网络"));
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap icon) { super.onPageStarted(v, url, icon); }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // 页面里扫二维码：要摄像头
            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                            req.grant(req.getResources());
                        } else {
                            pendingPerm = req;
                            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
                        }
                    }
                });
            }

            // 发图片 / 文件：系统的文件选择（相册、文件、拍照）
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try {
                    Intent i = params.createIntent();
                    if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(Intent.createChooser(i, "选择文件"), REQ_FILE);
                } catch (Exception e) {
                    fileCb = null;
                    return false;
                }
                return true;
            }
        });

        if (state != null) web.restoreState(state);
        else loadHome(getIntent());
    }

    private static boolean sameOrigin(Uri a, Uri b) {
        return a.getScheme() != null && a.getScheme().equalsIgnoreCase(b.getScheme())
            && a.getHost() != null && a.getHost().equalsIgnoreCase(b.getHost()) && a.getPort() == b.getPort();
    }

    private void loadHome(Intent intent) {
        // 用这个 App 打开的配对链接（https://中转地址/#p=…）：记下中转地址，直接配对
        Uri data = intent != null ? intent.getData() : null;
        if (data != null && data.getHost() != null) {
            prefs.edit().putString("relay", base(data.toString())).apply();
            web.loadUrl(data.toString());
            return;
        }
        String relay = prefs.getString("relay", "");
        web.loadUrl(relay.isEmpty() ? SETUP : relay);
    }

    // 去掉 # 后面的配对信息和多余的路径，只留中转地址
    private static String base(String url) {
        Uri u = Uri.parse(url);
        String s = u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        String p = u.getPath();
        if (p != null && p.length() > 1) s += p.endsWith("/") ? p.substring(0, p.length() - 1) : p;
        return s + "/";
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) loadHome(intent);
    }

    // 页面里调用：setup.html 填好中转地址
    private class Bridge {
        @JavascriptInterface
        public void setRelay(final String url) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    prefs.edit().putString("relay", base(url)).apply();
                    web.clearHistory();
                    web.loadUrl(url.contains("#") ? url : base(url));
                }
            });
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) { web.goBack(); return; }
        // 页面自己有弹层（抽屉、菜单）时先让页面关：页面通过 history 处理不了的才走到这里
        new AlertDialog.Builder(this)
            .setTitle("Claude 远程")
            .setItems(new CharSequence[]{"退出", "更换中转地址", "取消"}, new android.content.DialogInterface.OnClickListener() {
                @Override
                public void onClick(android.content.DialogInterface d, int which) {
                    if (which == 0) finish();
                    else if (which == 1) web.loadUrl(SETUP + "?url=" + Uri.encode(prefs.getString("relay", "")));
                }
            })
            .show();
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_FILE || fileCb == null) return;
        Uri[] out = null;
        if (res == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                out = new Uri[n];
                for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                out = new Uri[]{data.getData()};
            }
        }
        fileCb.onReceiveValue(out);
        fileCb = null;
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        if (req != REQ_CAMERA || pendingPerm == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) pendingPerm.grant(pendingPerm.getResources());
        else pendingPerm.deny();
        pendingPerm = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }
}
