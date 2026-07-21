package io.xkeen.mobile.app

import android.annotation.SuppressLint
import android.content.Context
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Color
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.core.content.edit
import org.json.JSONObject

@SuppressLint("SetJavaScriptEnabled", "ViewConstructor")
internal class XkeenTerminalWebView(
    context: Context,
    resumeKey: String,
) : WebView(context) {
    var onConnectionRequested: (String?, Long, Int, Int) -> Unit = { _, _, _, _ -> }
    var onTerminalStateChanged: (String, String) -> Unit = { _, _ -> }
    var onTerminalReady: (Int, Int) -> Unit = { _, _ -> }

    private var pageReady = false
    private var pendingConnection: PtyConnectionSpec? = null
    private val preferences = context.getSharedPreferences("xkeen_terminal_sessions", Context.MODE_PRIVATE)
    private val sessionKey = resumeKey.sha256Key()
    private val settledResize = Runnable {
        if (pageReady && width > 0 && height > 0) invoke("resize()")
    }

    init {
        setBackgroundColor(Color.rgb(1, 3, 10))
        // Some vendor WebView/GPU combinations keep xterm's DOM layer black until a later
        // invalidation. The software layer is deterministic and fast enough for the router PTY.
        setLayerType(View.LAYER_TYPE_SOFTWARE, null)
        isFocusable = true
        isFocusableInTouchMode = true
        overScrollMode = View.OVER_SCROLL_NEVER
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = false
        settings.allowContentAccess = false
        settings.allowFileAccess = true
        settings.blockNetworkLoads = false
        settings.cacheMode = WebSettings.LOAD_NO_CACHE
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.textZoom = 100
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        addJavascriptInterface(TerminalBridge(), BridgeName)
        webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                pageReady = true
                scheduleSettledResize()
                pendingConnection?.let {
                    pendingConnection = null
                    connect(it)
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean = true
        }
        loadUrl(TerminalAssetUrl)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (pageReady && w > 0 && h > 0 && (w != oldw || h != oldh)) {
            scheduleSettledResize()
        }
    }

    fun connect(spec: PtyConnectionSpec) {
        if (!pageReady) {
            pendingConnection = spec
            return
        }
        val payload = JSONObject()
            .put("webSocketUrl", spec.webSocketUrl)
            .put("sessionId", spec.sessionId ?: JSONObject.NULL)
            .put("lastSequence", spec.lastSequence)
            .put("columns", spec.columns)
            .put("rows", spec.rows)
        evaluateJavascript("window.XkeenTerminal && window.XkeenTerminal.connect(${payload});", null)
    }

    fun connectionRequestFailed(message: String) {
        if (pageReady) {
            evaluateJavascript(
                "window.XkeenTerminal && window.XkeenTerminal.connectionRequestFailed(${JSONObject.quote(message)});",
                null,
            )
        }
    }

    fun reconnect() = invoke("reconnect()")

    fun newSession() = invoke("newSession()")

    fun sendInterrupt() = invoke("signal('INT')")

    fun sendInput(data: String) {
        if (pageReady && data.isNotEmpty()) {
            evaluateJavascript(
                "window.XkeenTerminal && window.XkeenTerminal.input(${JSONObject.quote(data)});",
                null,
            )
        }
    }

    fun clearTerminal() = invoke("clear()")

    fun copySelection() {
        if (!pageReady) return
        evaluateJavascript("window.XkeenTerminal ? window.XkeenTerminal.selection() : '';") { encoded ->
            val selection = runCatching { JSONObject("{\"value\":$encoded}").optString("value") }
                .getOrDefault("")
            if (selection.isBlank()) {
                Toast.makeText(context, "В терминале нет выделенного текста.", Toast.LENGTH_SHORT).show()
                return@evaluateJavascript
            }
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("Terminal selection", selection))
            Toast.makeText(context, "Выделение скопировано.", Toast.LENGTH_SHORT).show()
        }
    }

    fun pasteClipboard() {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
        if (text.isNotEmpty()) {
            evaluateJavascript(
                "window.XkeenTerminal && window.XkeenTerminal.paste(${JSONObject.quote(text)});",
                null,
            )
        }
    }

    fun find(query: String, forward: Boolean) {
        val method = if (forward) "findNext" else "findPrevious"
        evaluateJavascript("window.XkeenTerminal && window.XkeenTerminal.$method(${JSONObject.quote(query)});", null)
    }

    fun focusTerminal() = invoke("focus()")

    fun resumeSnapshot(): Pair<String?, Long> =
        preferences.getString("${sessionKey}_id", null)?.takeIf(String::isNotBlank) to 0L

    fun release() {
        removeCallbacks(settledResize)
        if (pageReady) invoke("detach()")
        removeJavascriptInterface(BridgeName)
        stopLoading()
        destroy()
    }

    private fun invoke(expression: String) {
        if (pageReady) evaluateJavascript("window.XkeenTerminal && window.XkeenTerminal.$expression;", null)
    }

    private fun scheduleSettledResize() {
        removeCallbacks(settledResize)
        postDelayed(settledResize, RESIZE_SETTLE_MILLIS)
    }

    private inner class TerminalBridge {
        @JavascriptInterface
        fun onReady(columns: Int, rows: Int) {
            post { onTerminalReady(columns, rows) }
        }

        @JavascriptInterface
        fun requestConnection(sessionId: String, lastSequence: Long, columns: Int, rows: Int) {
            post {
                onConnectionRequested(
                    sessionId.trim().takeIf(String::isNotBlank),
                    lastSequence.coerceAtLeast(0),
                    columns,
                    rows,
                )
            }
        }

        @JavascriptInterface
        fun onState(state: String, message: String) {
            post { onTerminalStateChanged(state, message) }
        }

        @JavascriptInterface
        fun onSession(sessionId: String, _lastSequence: Long) {
            val normalized = sessionId.trim()
            if (normalized.isBlank()) {
                preferences.edit {
                    remove("${sessionKey}_id")
                    remove("${sessionKey}_seq")
                }
            } else {
                preferences.edit {
                    putString("${sessionKey}_id", normalized)
                    // The server session can be resumed, but a newly created WebView has an
                    // empty xterm buffer and must replay it from the beginning.
                    remove("${sessionKey}_seq")
                }
            }
        }
    }

    private companion object {
        const val BridgeName = "AndroidTerminal"
        const val TerminalAssetUrl = "file:///android_asset/terminal/terminal.html"
        const val RESIZE_SETTLE_MILLIS = 48L
    }
}

private fun String.sha256Key(): String = java.security.MessageDigest.getInstance("SHA-256")
    .digest(toByteArray(Charsets.UTF_8))
    .take(12)
    .joinToString("") { byte -> "%02x".format(byte) }
