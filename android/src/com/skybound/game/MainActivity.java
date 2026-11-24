package com.skybound.game;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Hosts the game's static files out of assets/www and serves them from a virtual
 * https origin, so ES modules, localStorage and WebGL all behave like a real site
 * without needing the network (the APK declares no INTERNET permission).
 */
public class MainActivity extends Activity {
  private static final String ORIGIN = "https://app.local/";
  private WebView web;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    setContentView(buildWebView());
    enterImmersive();
    web.loadUrl(ORIGIN + "index.html?mobile=1");
  }

  private WebView buildWebView() {
    web = new WebView(this);
    web.setBackgroundColor(Color.BLACK);
    // No scroll glow at the edges: a drag here is a joystick, not a page pan.
    web.setOverScrollMode(View.OVER_SCROLL_NEVER);
    web.setHorizontalScrollBarEnabled(false);
    web.setVerticalScrollBarEnabled(false);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setDisplayZoomControls(false);
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(false);
    s.setTextZoom(100);
    if (android.os.Build.VERSION.SDK_INT >= 26) {
      s.setSafeBrowsingEnabled(false);
    }

    web.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
        String path = req.getUrl().getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
        InputStream raw;
        try {
          raw = getAssets().open("www" + path);
        } catch (IOException e) {
          return null; // let the WebView show its own 404
        }

        String type = mime(path);
        boolean text = type.startsWith("text/") || type.contains("javascript") || type.contains("json");
        String charset = text ? "utf-8" : null;

        // The soundtrack files are tens of megabytes, and the media stack asks
        // for byte ranges instead of a whole body. Answer 206 with a bounded
        // stream, or WebView gives up with a format error and the game is silent.
        int total = 0;
        try {
          total = raw.available();
        } catch (IOException e) {
          total = 0;
        }
        String range = req.getRequestHeaders().get("Range");
        int start = 0;
        int end = total - 1;
        boolean partial = false;
        if (range != null && range.startsWith("bytes=")) {
          String spec = range.substring(6).trim();
          int dash = spec.indexOf('-');
          if (dash >= 0) {
            try {
              String a = spec.substring(0, dash).trim();
              String b = spec.substring(dash + 1).trim();
              if (a.isEmpty() && !b.isEmpty()) {
                int suffix = Integer.parseInt(b);
                start = Math.max(0, total - suffix);
                end = total - 1;
              } else {
                start = Integer.parseInt(a);
                end = b.isEmpty() ? total - 1 : Math.min(Integer.parseInt(b), total - 1);
              }
              partial = true;
            } catch (NumberFormatException e) {
              start = 0;
              end = total - 1;
              partial = false;
            }
          }
        }
        if (start > end || total == 0) {
          return new WebResourceResponse(type, charset, 416, "Range Not Satisfiable", null, raw);
        }

        long skip = start;
        while (skip > 0) {
          long jumped;
          try {
            jumped = raw.skip(skip);
          } catch (IOException e) {
            break;
          }
          if (jumped <= 0) break;
          skip -= jumped;
        }
        int length = end - start + 1;

        Map<String, String> headers = new HashMap<>();
        headers.put("Accept-Ranges", "bytes");
        headers.put("Cache-Control", "no-store");
        headers.put("Content-Length", String.valueOf(length));
        if (partial) headers.put("Content-Range", "bytes " + start + "-" + end + "/" + total);

        return new WebResourceResponse(
            type, charset, partial ? 206 : 200, partial ? "Partial Content" : "OK", headers,
            new SlicedStream(raw, length));
      }

      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
        return true; // the game is entirely local; never navigate away
      }
    });
    return web;
  }

  private static String mime(String path) {
    if (path.endsWith(".html")) return "text/html";
    if (path.endsWith(".js")) return "application/javascript";
    if (path.endsWith(".css")) return "text/css";
    if (path.endsWith(".json")) return "application/json";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".svg")) return "image/svg+xml";
    if (path.endsWith(".woff2")) return "font/woff2";
    if (path.endsWith(".wav")) return "audio/wav";
    if (path.endsWith(".mp3")) return "audio/mpeg";
    if (path.endsWith(".ogg")) return "audio/ogg";
    return "application/octet-stream";
  }

  /** Reads at most `remaining` bytes of a stream, so a 206 body stops at Content-Length. */
  private static final class SlicedStream extends InputStream {
    private final InputStream in;
    private int remaining;

    SlicedStream(InputStream in, int length) {
      this.in = in;
      this.remaining = length;
    }

    @Override
    public int read() throws IOException {
      if (remaining <= 0) return -1;
      int b = in.read();
      if (b >= 0) remaining--;
      return b;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
      if (remaining <= 0) return -1;
      int want = Math.min(length, remaining);
      int got = in.read(buffer, offset, want);
      if (got > 0) remaining -= got;
      return got;
    }

    @Override
    public void close() throws IOException {
      in.close();
    }
  }

  private void enterImmersive() {
    View decor = getWindow().getDecorView();
    decor.setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) enterImmersive();
  }

  /** Back pauses a running level, resumes a paused one, and otherwise closes. */
  @Override
  public void onBackPressed() {
    String js = "(function(){var g=window.SKYBOUND&&window.SKYBOUND.game;"
        + "if(!g)return 'exit';"
        + "if(g.mode==='playing'||g.mode==='paused'){"
        + "window.dispatchEvent(new KeyboardEvent('keydown',{code:'Escape'}));return 'handled';}"
        + "return 'exit';})()";
    web.evaluateJavascript(js, new ValueCallback<String>() {
      @Override
      public void onReceiveValue(String value) {
        if (value == null || value.contains("exit")) finish();
      }
    });
  }

  @Override
  protected void onDestroy() {
    if (web != null) web.destroy();
    super.onDestroy();
  }
}
