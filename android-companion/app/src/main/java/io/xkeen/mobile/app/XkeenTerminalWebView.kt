package io.xkeen.mobile.app

import android.annotation.SuppressLint
import android.content.Context
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Color
import android.graphics.Rect
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.core.content.edit
import org.json.JSONObject
import java.lang.ref.WeakReference

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
    private val inputMethodManager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    private var touchDownX = 0f
    private var touchDownY = 0f
    private var touchMoved = false
    private var routingWindowTouch = false

    init {
        activeTouchTarget = WeakReference(this)
        setBackgroundColor(Color.rgb(1, 3, 10))
        isClickable = true
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
                pendingConnection?.let {
                    pendingConnection = null
                    connect(it)
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean = true
        }
        loadUrl(TerminalAssetUrl)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        activeTouchTarget = WeakReference(this)
    }

    override fun onDetachedFromWindow() {
        routingWindowTouch = false
        super.onDetachedFromWindow()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        var focusAfterDispatch = false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                requestFocusFromTouch()
                touchDownX = event.x
                touchDownY = event.y
                touchMoved = false
            }

            MotionEvent.ACTION_MOVE -> {
                if (
                    kotlin.math.abs(event.x - touchDownX) > touchSlop ||
                    kotlin.math.abs(event.y - touchDownY) > touchSlop
                ) {
                    touchMoved = true
                }
            }

            MotionEvent.ACTION_UP -> {
                focusAfterDispatch = !touchMoved &&
                    kotlin.math.abs(event.x - touchDownX) <= touchSlop &&
                    kotlin.math.abs(event.y - touchDownY) <= touchSlop
                touchMoved = false
            }

            MotionEvent.ACTION_CANCEL -> touchMoved = false
        }
        // WebView/xterm receives the complete gesture first, preserving native kinetic scroll.
        val handled = super.onTouchEvent(event)
        if (focusAfterDispatch) focusTerminalFromTouch()
        return handled
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
        routingWindowTouch = false
        if (pageReady) invoke("detach()")
        removeJavascriptInterface(BridgeName)
        stopLoading()
        destroy()
    }

    private fun invoke(expression: String) {
        if (pageReady) evaluateJavascript("window.XkeenTerminal && window.XkeenTerminal.$expression;", null)
    }

    private fun focusTerminalFromTouch() {
        if (!pageReady) return
        evaluateJavascript("window.XkeenTerminal && window.XkeenTerminal.focus();") {
            post { inputMethodManager.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT) }
        }
    }

    private fun routeWindowTouch(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            val visibleBounds = Rect()
            routingWindowTouch = isShown &&
                getGlobalVisibleRect(visibleBounds) &&
                visibleBounds.contains(event.rawX.toInt(), event.rawY.toInt())
        }
        if (!routingWindowTouch) return false

        val location = IntArray(2)
        getLocationOnScreen(location)
        val localEvent = MotionEvent.obtain(event)
        localEvent.offsetLocation(
            event.rawX - event.x - location[0],
            event.rawY - event.y - location[1],
        )
        try {
            dispatchTouchEvent(localEvent)
        } finally {
            localEvent.recycle()
        }
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            routingWindowTouch = false
        }
        return true
    }

    private inner class TerminalBridge {
        @JavascriptInterface
        fun onReady(columns: Int, rows: Int) {
            post {
                // The xterm canvas and font metrics now exist. Invalidate this hardware-backed
                // WebView once for vendor renderers that defer its first composed frame.
                this@XkeenTerminalWebView.postInvalidateOnAnimation()
                onTerminalReady(columns, rows)
            }
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

    companion object {
        private var activeTouchTarget = WeakReference<XkeenTerminalWebView>(null)
        private var touchRoutingEnabled = false

        internal fun setTouchRoutingEnabled(enabled: Boolean) {
            touchRoutingEnabled = enabled
        }

        internal fun routeTouchFromActivity(event: MotionEvent): Boolean =
            touchRoutingEnabled && activeTouchTarget.get()?.routeWindowTouch(event) == true

        private const val BridgeName = "AndroidTerminal"
        private const val TerminalAssetUrl = "file:///android_asset/terminal/terminal.html"
    }
}

private fun String.sha256Key(): String = java.security.MessageDigest.getInstance("SHA-256")
    .digest(toByteArray(Charsets.UTF_8))
    .take(12)
    .joinToString("") { byte -> "%02x".format(byte) }
