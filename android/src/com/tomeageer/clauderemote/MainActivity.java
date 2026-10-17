package com.tomeageer.clauderemote;

// Claude 远程（安卓）：一个薄壳，显示手机网页（和 iPhone 用 Safari 打开的是同一份代码）。
// 页面代码打包在 App 里（assets/page，打包时从仓库的 mobile/ 原样拷进来），不从网上加载：
// 中转服务器只负责转发密文，碰不到页面代码。中转地址在扫码配对时从二维码里拿到。
// 以前填过中转地址、用中转上的页面配对的老用户：照常打开那个页面（旧配对继续能用），
// 一扫到新的一次性二维码就切到 App 自带的页面。
// 壳只补浏览器缺的几样：页面里扫码要的摄像头权限、发图片 / 文件要的文件选择、返回键。

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
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private static final String SETUP = "file:///android_asset/setup.html";
    // 自带页面的地址：这个域名只在 App 里由下面的 shouldInterceptRequest 从 assets/page 读，不会真的联网
    private static final String PAGE_HOST = "appassets.androidplatform.net";
    private static final String PAGE = "https://" + PAGE_HOST + "/page/";
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
                // 配对链接（不管指向哪个页面）：一律在 App 自带的页面里配对
                if (isPairLink(u)) { openBundled(u.getEncodedFragment()); return true; }
                // 自带页面、老用户的中转页面在 App 里打开，别的链接交给系统浏览器
                if (PAGE_HOST.equals(u.getHost()) || u.toString().startsWith("file:///android_asset/") || (!relay.isEmpty() && sameOrigin(u, Uri.parse(relay)))) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            // 自带页面：从 assets/page 读文件
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!PAGE_HOST.equals(u.getHost())) return null;
                String path = u.getPath() == null ? "" : u.getPath();
                if (!path.startsWith("/page/") || path.contains("..")) return notFound();
                String rel = path.substring(6);
                if (rel.isEmpty()) rel = "index.html";
                try {
                    return new WebResourceResponse(mime(rel), "utf-8", getAssets().open("page/" + rel));
                } catch (IOException e) {
                    return notFound();
                }
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError e) {
                if (!req.isForMainFrame() || PAGE_HOST.equals(req.getUrl().getHost())) return;
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

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, new ByteArrayInputStream(new byte[0]));
    }

    private static String mime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".js")) return "application/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    private static boolean isPairLink(Uri u) {
        String f = u.getEncodedFragment();
        return f != null && (f.startsWith("p=") || f.contains("&p="));
    }

    // 切到 App 自带的页面（以后都用它），带着配对信息就直接配对
    private void openBundled(String fragment) {
        prefs.edit().putBoolean("bundled", true).apply();
        web.clearHistory();
        web.loadUrl(PAGE + (fragment != null ? "#" + fragment : ""));
    }

    private void loadHome(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data != null && isPairLink(data)) { openBundled(data.getEncodedFragment()); return; }
        // 老用户（填过中转地址、还没用新方式配对）：照常打开中转上的页面，旧配对继续能用
        String relay = prefs.getString("relay", "");
        if (!prefs.getBoolean("bundled", false) && !relay.isEmpty()) web.loadUrl(relay);
        else web.loadUrl(PAGE);
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
            .setItems(new CharSequence[]{"退出", "取消"}, new android.content.DialogInterface.OnClickListener() {
                @Override
                public void onClick(android.content.DialogInterface d, int which) {
                    if (which == 0) finish();
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
