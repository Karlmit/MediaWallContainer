package com.kwa.mediawall

import android.app.Activity
import android.content.res.Configuration
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.VideoView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.random.Random

private const val MAX_ANDROID_ITEMS = 15
private const val RANDOM_SWAP_MS = 15_000L

class MainActivity : Activity() {
    private val executor = Executors.newFixedThreadPool(6)
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var prefs: android.content.SharedPreferences
    private lateinit var root: FrameLayout
    private lateinit var wall: FrameLayout
    private lateinit var splash: TextView
    private lateinit var menuButton: Button
    private lateinit var selectedOnlyButton: Button
    private var overlayView: View? = null

    private var serverUrl = ""
    private var password = ""
    private var sessionCookie = ""
    private var itemCount = 6
    private var localOptimizedCache = false
    private var pinEnabled = false
    private var pinCode = ""
    private var allowVertical = true
    private var allowHorizontal = true
    private var allMedia = emptyList<MediaItem>()
    private var subfolders = emptyList<SubfolderItem>()
    private var excludedSubfolders = mutableSetOf<String>()
    private var activeMedia = emptyList<MediaItem>()
    private val tileViews = mutableMapOf<String, FrameLayout>()
    private var touchStartY = 0f
    private var touchLastY = 0f
    private var touchStartTime = 0L
    private var touchChangedItemCount = false
    private val selectedItemIds = mutableSetOf<String>()
    private var longPressItemId: String? = null
    private var longPressTriggered = false
    private val longPressRunnable = Runnable {
        longPressItemId?.let {
            longPressTriggered = true
            toggleSelectedItem(it)
        }
    }
    private var menuVisible = false
    private var offlineMode = false
    private var randomPaused = false
    private var overlayScreen = ""
    private var downloadAllInProgress = false
    private var downloadStatusText = "Idle"
    private var downloadTotal = 0
    private var downloadDone = 0
    private var downloadFailed = 0
    private var downloadCurrent = ""
    private var downloadLastUiRefresh = 0L
    private var downloadCancelRequested = false
    private val downloadJobs = mutableListOf<DownloadJob>()
    private val failedDownloadIds = mutableSetOf<String>()
    private val randomSwapRunnable = object : Runnable {
        override fun run() {
            if (!randomPaused && !menuVisible) replaceRandomItem()
            scheduleRandomSwap()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        hideSystemUi()
        prefs = getSharedPreferences("mediawall", MODE_PRIVATE)
        serverUrl = prefs.getString("serverUrl", "") ?: ""
        password = prefs.getString("password", "") ?: ""
        itemCount = prefs.getInt("itemCount", 6).coerceIn(1, MAX_ANDROID_ITEMS)
        localOptimizedCache = prefs.getBoolean("localOptimizedCache", false)
        pinEnabled = prefs.getBoolean("pinEnabled", false)
        pinCode = prefs.getString("pinCode", "") ?: ""
        allowVertical = prefs.getBoolean("allowVertical", true)
        allowHorizontal = prefs.getBoolean("allowHorizontal", true)
        excludedSubfolders = (prefs.getStringSet("excludedSubfolders", emptySet()) ?: emptySet()).toMutableSet()
        buildRoot()
        if (pinEnabled && pinCode.isNotBlank()) {
            showPinScreen()
        } else if (serverUrl.isBlank()) {
            showMainMenu()
        } else {
            connectAndLoad()
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        hideSystemUi()
        if (!menuVisible && activeMedia.isNotEmpty()) {
            mainHandler.post { renderWall() }
        }
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(randomSwapRunnable)
        super.onDestroy()
    }

    private fun hideSystemUi() {
        window.decorView.windowInsetsController?.let {
            it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    private fun buildRoot() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(5, 5, 7)) }
        wall = FrameLayout(this)
        splash = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 28f
            gravity = Gravity.CENTER
            setBackgroundColor(Color.argb(190, 8, 9, 13))
            visibility = View.GONE
        }
        menuButton = Button(this).apply {
            text = "Menu"
            alpha = 0.88f
            setOnClickListener { showMainMenu() }
        }
        selectedOnlyButton = Button(this).apply {
            text = "Show selected"
            alpha = 0.9f
            visibility = View.GONE
            setOnClickListener { showSelectedItemsOnly() }
        }
        root.addView(wall, FrameLayout.LayoutParams(-1, -1))
        root.addView(selectedOnlyButton, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.START).apply {
            setMargins(16, 16, 0, 0)
        })
        root.addView(menuButton, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply {
            setMargins(0, 16, 16, 0)
        })
        root.addView(splash, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER).apply {
            setMargins(24, 24, 24, 24)
        })
        root.setOnTouchListener { _, event -> handleWallTouch(event) }
        setContentView(root)
    }

    private fun handleWallTouch(event: MotionEvent): Boolean {
        if (menuVisible) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                touchStartY = event.y
                touchLastY = event.y
                touchStartTime = System.currentTimeMillis()
                touchChangedItemCount = false
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val dy = event.y - touchLastY
                if (kotlin.math.abs(dy) > 110) {
                    changeItemCount(if (dy < 0) 1 else -1)
                    touchLastY = event.y
                    touchChangedItemCount = true
                    return true
                }
            }
            MotionEvent.ACTION_UP -> {
                val dy = event.y - touchStartY
                val quickEnough = System.currentTimeMillis() - touchStartTime < 900
                if (!touchChangedItemCount && quickEnough && kotlin.math.abs(dy) > 80) {
                    changeItemCount(if (dy < 0) 1 else -1)
                    return true
                }
            }
        }
        return true
    }

    private fun handleTileTouch(event: MotionEvent, itemId: String): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                longPressItemId = itemId
                longPressTriggered = false
                mainHandler.removeCallbacks(longPressRunnable)
                mainHandler.postDelayed(longPressRunnable, 500)
            }
            MotionEvent.ACTION_MOVE -> {
                val dy = kotlin.math.abs(event.y - touchStartY)
                if (dy > 35) mainHandler.removeCallbacks(longPressRunnable)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                mainHandler.removeCallbacks(longPressRunnable)
            }
        }
        val handled = handleWallTouch(event)
        if (event.actionMasked == MotionEvent.ACTION_UP) {
            val dy = kotlin.math.abs(event.y - touchStartY)
            val quickEnough = System.currentTimeMillis() - touchStartTime < 900
            if (!longPressTriggered && !touchChangedItemCount && quickEnough && dy < 35) replaceItem(itemId)
            longPressItemId = null
            longPressTriggered = false
        }
        if (event.actionMasked == MotionEvent.ACTION_CANCEL) {
            longPressItemId = null
            longPressTriggered = false
        }
        return handled
    }

    private fun showPinScreen() {
        menuVisible = true
        overlayScreen = "pin"
        wall.removeAllViews()
        showOverlay(panel("Unlock MediaWall").apply {
            val pinInput = numericPinInput("PIN")
            addView(pinInput)
            addView(button("Unlock") {
                if (pinInput.text.toString() == pinCode) {
                    clearOverlay()
                    menuVisible = false
                    if (serverUrl.isBlank()) showMainMenu() else connectAndLoad()
                } else {
                    toast("Wrong PIN")
                }
            })
        })
    }

    private fun showMainMenu() {
        menuVisible = true
        overlayScreen = "main"
        showOverlay(panel("MediaWall").apply {
            addView(TextView(context).apply {
                text = buildString {
                    append(if (offlineMode) "Offline mode" else "Online mode")
                    append("\n")
                    append("${filteredMedia().size} / ${allMedia.size} media items")
                    append("\n")
                    append("$itemCount visible item${if (itemCount == 1) "" else "s"}")
                    if (serverUrl.isNotBlank()) append("\n$serverUrl")
                }
                setTextColor(Color.rgb(166, 167, 173))
                textSize = 14f
                setPadding(0, 0, 0, 14)
            })
            addView(button(if (randomPaused) "Resume random swaps" else "Pause random swaps") {
                randomPaused = !randomPaused
                if (randomPaused) {
                    mainHandler.removeCallbacks(randomSwapRunnable)
                    toast("Random swaps paused")
                } else {
                    scheduleRandomSwap()
                    toast("Random swaps resumed")
                }
                showMainMenu()
            })
            addView(button("Refresh media") {
                clearOverlay()
                menuVisible = false
                connectAndLoad()
            })
            val verticalToggle = CheckBox(context).apply {
                text = "Allow vertical"
                setTextColor(Color.WHITE)
                isChecked = allowVertical
                textSize = 18f
                setPadding(0, 6, 0, 6)
                setOnCheckedChangeListener { _, checked ->
                    allowVertical = checked
                    saveDisplaySettings()
                    applySubfolderFilters()
                }
            }
            val horizontalToggle = CheckBox(context).apply {
                text = "Allow horizontal"
                setTextColor(Color.WHITE)
                isChecked = allowHorizontal
                textSize = 18f
                setPadding(0, 6, 0, 6)
                setOnCheckedChangeListener { _, checked ->
                    allowHorizontal = checked
                    saveDisplaySettings()
                    applySubfolderFilters()
                }
            }
            addView(verticalToggle)
            addView(horizontalToggle)
            addView(button("Subfolders") { showSubfolderScreen() })
            addView(button("Settings") { showSettingsScreen() })
            addView(button("Close menu") {
                clearOverlay()
                menuVisible = false
                if (activeMedia.isEmpty() && allMedia.isNotEmpty()) {
                    activeMedia = pickActiveMedia()
                    renderWall()
                }
                scheduleRandomSwap()
            })
        })
    }

    private fun showSettingsScreen() {
        menuVisible = true
        overlayScreen = "settings"
        val panel = panel("Settings")
        val urlInput = input("Docker URL, for example http://192.168.1.10:3060", false).apply {
            setText(serverUrl)
        }
        val passwordInput = input("Docker password", true).apply {
            setText(password)
        }
        panel.addView(urlInput)
        panel.addView(passwordInput)
        panel.addView(button("Connect") {
            serverUrl = normalizeServerUrl(urlInput.text.toString())
            password = passwordInput.text.toString()
            prefs.edit()
                .putString("serverUrl", serverUrl)
                .putString("password", password)
                .apply()
            clearOverlay()
            menuVisible = false
            connectAndLoad()
        })
        panel.addView(button("Open offline") {
            clearOverlay()
            menuVisible = false
            if (!openOfflineMode()) {
                toast("No cached offline videos yet")
                showSettingsScreen()
            }
        })
        panel.addView(button("Local downloads") { showDownloadStatusScreen() })
        val pinToggle = CheckBox(this).apply {
            text = "Lock app behind PIN"
            setTextColor(Color.WHITE)
            isChecked = pinEnabled
        }
        val pinInput = numericPinInput("PIN").apply {
            setText(pinCode)
        }
        panel.addView(pinToggle)
        panel.addView(pinInput)
        panel.addView(button("Save settings") {
            pinEnabled = pinToggle.isChecked
            pinCode = pinInput.text.toString()
            prefs.edit()
                .putBoolean("pinEnabled", pinEnabled)
                .putString("pinCode", pinCode)
                .apply()
            toast("Settings saved")
            showMainMenu()
        })
        panel.addView(button("Back to menu") { showMainMenu() })
        showOverlay(panel)
    }

    private fun showSubfolderScreen() {
        menuVisible = true
        overlayScreen = "subfolders"
        showOverlay(panel("Subfolders").apply {
            addView(TextView(context).apply {
                text = if (subfolders.isEmpty()) {
                    "No subfolders found"
                } else {
                    "${filteredMedia().size} / ${allMedia.size} media items visible"
                }
                setTextColor(Color.rgb(166, 167, 173))
                textSize = 14f
                setPadding(0, 0, 0, 14)
            })
            if (subfolders.isNotEmpty()) {
                addView(button("Select all subfolders") {
                    excludedSubfolders.clear()
                    saveSubfolderSettings()
                    applySubfolderFilters()
                    showSubfolderScreen()
                })
                addView(button("Deselect all subfolders") {
                    excludedSubfolders = subfolders.map { it.path }.toMutableSet()
                    saveSubfolderSettings()
                    applySubfolderFilters()
                    showSubfolderScreen()
                })
                subfolders.forEach { subfolder ->
                    addView(CheckBox(context).apply {
                        text = subfolder.name
                        setTextColor(Color.WHITE)
                        textSize = 18f
                        isChecked = subfolder.path !in excludedSubfolders
                        setPadding(0, 8, 0, 8)
                        setOnCheckedChangeListener { _, checked ->
                            if (checked) {
                                excludedSubfolders.remove(subfolder.path)
                            } else {
                                excludedSubfolders.add(subfolder.path)
                            }
                            saveSubfolderSettings()
                            applySubfolderFilters()
                        }
                    })
                }
            }
            addView(button("Back to menu") { showMainMenu() })
        })
    }

    private fun showDownloadStatusScreen() {
        menuVisible = true
        overlayScreen = "downloads"
        showFullScreenOverlay(panel("Local downloads").apply {
            val stats = cacheStats()
            addView(TextView(context).apply {
                text = buildString {
                    append("Videos saved here can play without network access. MediaWall saves the optimized version when the server has one.\n\n")
                    append("Status: $downloadStatusText\n")
                    if (downloadCurrent.isNotBlank()) append("Current: $downloadCurrent\n")
                    if (downloadTotal > 0) append("Progress: $downloadDone / $downloadTotal, failed $downloadFailed\n")
                    append("\n")
                    append("${stats.cachedVideos} / ${stats.knownVideos} videos saved locally\n")
                    append("${formatBytes(stats.bytes)} stored in app-private storage\n")
                    append("${downloadTargets().size} videos still need local copies\n\n")
                    append("Downloads run one at a time to keep the phone responsive. The wall uses the same local files as this page, so watching a video also saves it if it is missing.")
                }
                setTextColor(Color.WHITE)
                textSize = 15f
                setPadding(0, 0, 0, 16)
            })
            addView(button("Download all missing videos") {
                downloadVideos(downloadTargets())
                showDownloadStatusScreen()
            })
            addView(button("Stop downloads") {
                downloadCancelRequested = true
                downloadStatusText = "Stopping downloads"
                showDownloadStatusScreen()
            }.apply {
                isEnabled = downloadAllInProgress
            })
            addView(button("Retry failed downloads") {
                retryFailedDownloads()
                showDownloadStatusScreen()
            }.apply {
                isEnabled = failedDownloadIds.isNotEmpty()
            })
            addView(button("Clear private video cache") {
                File(filesDir, "optimized").deleteRecursively()
                downloadStatusText = "Private optimized cache cleared"
                downloadCurrent = ""
                downloadTotal = 0
                downloadDone = 0
                downloadFailed = 0
                downloadCancelRequested = false
                downloadJobs.clear()
                failedDownloadIds.clear()
                toast("Private cache cleared")
                showDownloadStatusScreen()
            })
            if (downloadJobs.isNotEmpty()) {
                val visibleJobs = visibleDownloadJobs()
                addView(TextView(context).apply {
                    text = "Active download queue (${visibleJobs.size} shown of ${downloadJobs.size})"
                    setTextColor(Color.WHITE)
                    textSize = 18f
                    setPadding(0, 14, 0, 8)
                })
                visibleJobs.forEach { job -> addView(downloadJobRow(job)) }
            } else {
                addView(TextView(context).apply {
                    text = "No active downloads. Start a download above, or retry failed downloads after a failed run."
                    setTextColor(Color.rgb(166, 167, 173))
                    textSize = 14f
                    setPadding(0, 14, 0, 14)
                })
            }
            addView(button("Open offline") {
                clearOverlay()
                restoreWallSurface()
                menuVisible = false
                if (!openOfflineMode()) {
                    toast("No cached offline videos yet")
                    showDownloadStatusScreen()
                }
            })
            addView(button("Back to settings") {
                clearOverlay()
                restoreWallSurface()
                showSettingsScreen()
            })
        })
    }

    private fun downloadJobRow(job: DownloadJob): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 8, 0, 10)
            addView(TextView(context).apply {
                text = buildString {
                    append(job.item.path)
                    append("\n")
                    append(job.status.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.US) else it.toString() })
                    if (job.totalBytes > 0) append(" ${job.percent()}%")
                    if (job.error.isNotBlank()) append(" - ${job.error}")
                }
                setTextColor(if (job.status == "failed") Color.rgb(255, 149, 149) else Color.WHITE)
                textSize = 13f
            })
            addView(ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
                max = 100
                progress = job.percent()
                isIndeterminate = job.status == "downloading" && job.totalBytes <= 0
            }, LinearLayout.LayoutParams(-1, 18))
        }
    }

    private fun visibleDownloadJobs(): List<DownloadJob> {
        return downloadJobs.sortedWith { left, right ->
            val priorityCompare = downloadStatusPriority(left.status).compareTo(downloadStatusPriority(right.status))
            if (priorityCompare != 0) return@sortedWith priorityCompare

            if (left.status == "queued" && right.status == "queued") {
                return@sortedWith left.order.compareTo(right.order)
            }

            right.updatedAt.compareTo(left.updatedAt)
        }.take(10)
    }

    private fun downloadStatusPriority(status: String): Int {
        return when (status) {
            "downloading" -> 0
            "failed" -> 1
            "queued" -> 2
            "canceled" -> 3
            "finished" -> 4
            else -> 5
        }
    }

    private fun updateDownloadJob(job: DownloadJob, status: String? = null, error: String? = null) {
        status?.let { job.status = it }
        error?.let { job.error = it }
        job.updatedAt = System.currentTimeMillis()
    }

    private fun panel(title: String): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 24, 28, 24)
            setBackgroundColor(Color.argb(235, 18, 19, 24))
            addView(TextView(context).apply {
                text = title
                setTextColor(Color.WHITE)
                textSize = 22f
                setPadding(0, 0, 0, 18)
            })
        }
    }

    private fun centeredPanelParams(): FrameLayout.LayoutParams {
        return FrameLayout.LayoutParams(
            min(resources.displayMetrics.widthPixels - 40, 760),
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER
        )
    }

    private fun showOverlay(content: View) {
        restoreWallSurface()
        clearOverlay()
        val scroll = ScrollView(this).apply {
            setPadding(0, 20, 0, 20)
            addView(content)
        }
        overlayView = scroll
        root.addView(scroll, centeredPanelParams())
    }

    private fun showFullScreenOverlay(content: View) {
        clearOverlay()
        mainHandler.removeCallbacks(randomSwapRunnable)
        pauseWallVideos()
        wall.visibility = View.GONE
        menuButton.visibility = View.GONE
        selectedOnlyButton.visibility = View.GONE
        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.rgb(5, 5, 7))
            setPadding(18, 18, 18, 18)
            addView(content, ViewGroup.LayoutParams(-1, -2))
        }
        overlayView = scroll
        root.addView(scroll, FrameLayout.LayoutParams(-1, -1))
    }

    private fun pauseWallVideos() {
        tileViews.values.forEach { tile ->
            findVideoViews(tile).forEach { it.pause() }
        }
    }

    private fun findVideoViews(view: View): List<VideoView> {
        if (view is VideoView) return listOf(view)
        if (view !is FrameLayout) return emptyList()
        val videos = mutableListOf<VideoView>()
        for (index in 0 until view.childCount) {
            videos.addAll(findVideoViews(view.getChildAt(index)))
        }
        return videos
    }

    private fun restoreWallSurface() {
        wall.visibility = View.VISIBLE
        menuButton.visibility = View.VISIBLE
        selectedOnlyButton.visibility = if (selectedItemIds.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun clearOverlay() {
        overlayView?.let { root.removeView(it) }
        overlayView = null
    }

    private fun input(hintText: String, passwordField: Boolean): EditText {
        return EditText(this).apply {
            hint = hintText
            setTextColor(Color.WHITE)
            setHintTextColor(Color.rgb(166, 167, 173))
            setSingleLine(true)
            if (passwordField) inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
    }

    private fun numericPinInput(hintText: String): EditText {
        return EditText(this).apply {
            hint = hintText
            setTextColor(Color.WHITE)
            setHintTextColor(Color.rgb(166, 167, 173))
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD
        }
    }

    private fun button(label: String, action: View.() -> Unit): Button {
        return Button(this).apply {
            text = label
            setOnClickListener { action() }
        }
    }

    private fun connectAndLoad() {
        showCenter("Connecting")
        executor.execute {
            try {
                loginIfNeeded()
                val loaded = fetchMediaResult()
                cleanupLocalDownloads(loaded.media)
                mainHandler.post {
                    offlineMode = false
                    allMedia = loaded.media
                    subfolders = loaded.subfolders
                    excludedSubfolders.retainAll(subfolders.map { it.path }.toSet())
                    saveSubfolderSettings()
                    activeMedia = pickActiveMedia()
                    renderWall()
                    scheduleRandomSwap()
                    prefs.edit().putString("lastMediaJson", loaded.rawJson).apply()
                    showCenter("Loaded ${allMedia.size} items", 900)
                }
            } catch (error: Exception) {
                mainHandler.post {
                    if (openOfflineMode()) {
                        showCenter("Offline mode", 1600)
                    } else {
                        showCenter("Connection failed: ${error.message}", 3500)
                        showMainMenu()
                    }
                }
            }
        }
    }

    private fun loginIfNeeded() {
        if (password.isBlank()) return
        val body = "password=${java.net.URLEncoder.encode(password, "UTF-8")}"
        val connection = (URL("$serverUrl/login").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            instanceFollowRedirects = false
            setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            outputStream.use { it.write(body.toByteArray()) }
        }
        val status = connection.responseCode
        sessionCookie = connection.headerFields["Set-Cookie"]?.firstOrNull()?.substringBefore(";") ?: ""
        connection.inputStreamOrError().close()
        if (status !in 200..399 || sessionCookie.isBlank()) {
            throw IllegalStateException("login failed, check password")
        }
    }

    private fun fetchMediaResult(): MediaResult {
        val text = requestText("$serverUrl/api/media")
        val result = JSONObject(text)
        val array = result.optJSONArray("media") ?: JSONArray()
        val subfolderArray = result.optJSONArray("subfolders") ?: JSONArray()
        return MediaResult(parseMediaArray(array), parseSubfolderArray(subfolderArray), text)
    }

    private fun parseMediaArray(array: JSONArray): List<MediaItem> {
        return List(array.length()) { index ->
            val obj = array.getJSONObject(index)
            MediaItem(
                id = obj.getString("id"),
                name = obj.optString("name", obj.getString("id")),
                type = obj.getString("type"),
                path = obj.optString("path", obj.getString("id")),
                url = absoluteUrl(obj.getString("url")),
                optimizedUrl = obj.optString("optimizedUrl").takeIf { it.isNotBlank() && it != "null" }?.let(::absoluteUrl),
                fallbackUrl = obj.optString("fallbackUrl").takeIf { it.isNotBlank() && it != "null" }?.let(::absoluteUrl),
                sourceWidth = obj.optInt("sourceWidth").takeIf { it > 0 },
                sourceHeight = obj.optInt("sourceHeight").takeIf { it > 0 }
            )
        }
    }

    private fun parseSubfolderArray(array: JSONArray): List<SubfolderItem> {
        return List(array.length()) { index ->
            val obj = array.getJSONObject(index)
            SubfolderItem(
                name = obj.optString("name", obj.optString("path", "")),
                path = obj.optString("path")
            )
        }.filter { it.path.isNotBlank() }
    }

    private fun openOfflineMode(): Boolean {
        val savedJson = prefs.getString("lastMediaJson", null) ?: return false
        return try {
            val result = JSONObject(savedJson)
            val media = parseMediaArray(result.optJSONArray("media") ?: JSONArray())
            subfolders = parseSubfolderArray(result.optJSONArray("subfolders") ?: JSONArray())
            excludedSubfolders.retainAll(subfolders.map { it.path }.toSet())
            saveSubfolderSettings()
            val cached = media.filter { item ->
                item.type == "video" && localOptimizedFile(item)?.exists() == true
            }
            if (cached.isEmpty()) return false
            offlineMode = true
            allMedia = cached
            activeMedia = pickActiveMedia()
            renderWall()
            scheduleRandomSwap()
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun requestText(url: String): String {
        val connection = open(url)
        val status = connection.responseCode
        val body = connection.inputStreamOrError().bufferedReader().use { it.readText() }
        if (status == 401) throw IllegalStateException("unauthorized, check password")
        if (status !in 200..299) throw IllegalStateException("HTTP $status")
        return body
    }

    private fun open(url: String): HttpURLConnection {
        return (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 30_000
            if (sessionCookie.isNotBlank()) setRequestProperty("Cookie", sessionCookie)
        }
    }

    private fun HttpURLConnection.inputStreamOrError() = try {
        inputStream
    } catch (_: Exception) {
        errorStream ?: throw IllegalStateException("HTTP $responseCode")
    }

    private fun normalizeServerUrl(value: String): String {
        val trimmed = value.trim().trimEnd('/')
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed
        return "http://$trimmed"
    }

    private fun absoluteUrl(url: String): String {
        if (url.startsWith("http://") || url.startsWith("https://")) return url
        return "$serverUrl$url"
    }

    private fun pickActiveMedia(): List<MediaItem> {
        val media = filteredMedia()
        if (media.isEmpty()) return emptyList()
        return media.shuffled().take(minOf(itemCount, MAX_ANDROID_ITEMS, media.size))
    }

    private fun resizeActiveMedia(targetCount: Int): List<MediaItem> {
        val media = filteredMedia()
        if (media.isEmpty() || targetCount <= 0) return emptyList()
        val target = minOf(targetCount, MAX_ANDROID_ITEMS, media.size)
        val existing = activeMedia.filter { active ->
            media.any { it.id == active.id }
        }.take(target).toMutableList()
        if (existing.size >= target) return existing

        val existingIds = existing.mapTo(mutableSetOf()) { it.id }
        val candidates = media.filter { it.id !in existingIds }.shuffled()
        existing.addAll(candidates.take(target - existing.size))
        return existing
    }

    private fun filteredMedia(): List<MediaItem> {
        return allMedia.filter { item ->
            excludedSubfolders.none { subfolderPath -> item.isInsideSubfolder(subfolderPath) } &&
                item.isAllowedOrientation()
        }
    }

    private fun MediaItem.isAllowedOrientation(): Boolean {
        if (allowVertical && allowHorizontal) return true
        if (!allowVertical && !allowHorizontal) return false
        val vertical = isVertical()
        return if (vertical) allowVertical else allowHorizontal
    }

    private fun MediaItem.isVertical(): Boolean {
        val width = sourceWidth ?: 0
        val height = sourceHeight ?: 0
        if (width > 0 && height > 0) return height > width
        return aspectRatio() < 1.0
    }

    private fun MediaItem.isInsideSubfolder(subfolderPath: String): Boolean {
        val itemPath = path.replace("\\", "/").lowercase(Locale.US)
        val folderPath = subfolderPath.replace("\\", "/").lowercase(Locale.US)
        return itemPath == folderPath || itemPath.startsWith("$folderPath/")
    }

    private fun saveSubfolderSettings() {
        prefs.edit().putStringSet("excludedSubfolders", excludedSubfolders).apply()
    }

    private fun saveDisplaySettings() {
        prefs.edit()
            .putBoolean("allowVertical", allowVertical)
            .putBoolean("allowHorizontal", allowHorizontal)
            .apply()
    }

    private fun applySubfolderFilters() {
        activeMedia = resizeActiveMedia(itemCount)
        renderWall()
        scheduleRandomSwap()
    }

    private fun renderWall() {
        if (activeMedia.isEmpty()) {
            wall.removeAllViews()
            tileViews.clear()
            selectedItemIds.clear()
            updateSelectionUi()
            showCenter("No media found")
            return
        }
        val activeIds = activeMedia.mapTo(mutableSetOf()) { it.id }
        selectedItemIds.retainAll(activeIds)
        tileViews.entries.toList().forEach { (id, tile) ->
            if (id !in activeIds) {
                wall.removeView(tile)
                tileViews.remove(id)
            }
        }
        layoutTiles(activeMedia).forEachIndexed { index, rect ->
            val item = activeMedia[index]
            val tile = tileViews[item.id] ?: FrameLayout(this).apply {
                setBackgroundColor(Color.rgb(17, 18, 23))
                val progress = ProgressBar(this@MainActivity)
                addView(progress, FrameLayout.LayoutParams(56, 56, Gravity.CENTER))
                tileViews[item.id] = this
                wall.addView(this)
                loadTile(this, progress, item)
            }
            tile.setOnTouchListener { _, event -> handleTileTouch(event, item.id) }
            tile.setBackgroundColor(
                if (item.id in selectedItemIds) Color.rgb(42, 112, 93) else Color.rgb(17, 18, 23)
            )
            tile.foreground = if (item.id in selectedItemIds) ColorDrawable(Color.argb(86, 86, 210, 172)) else null
            tile.layoutParams = FrameLayout.LayoutParams(rect.width, rect.height).apply {
                leftMargin = rect.x
                topMargin = rect.y
            }
        }
        updateSelectionUi()
    }

    private fun toggleSelectedItem(itemId: String) {
        if (itemId in selectedItemIds) {
            selectedItemIds.remove(itemId)
            showCenter("Deselected", 700)
        } else {
            selectedItemIds.add(itemId)
            showCenter("${selectedItemIds.size} selected", 700)
        }
        updateSelectionUi()
    }

    private fun updateSelectionUi() {
        selectedOnlyButton.visibility = if (selectedItemIds.isEmpty()) View.GONE else View.VISIBLE
        selectedOnlyButton.text = "Show selected (${selectedItemIds.size})"
        tileViews.forEach { (id, tile) ->
            tile.setBackgroundColor(
                if (id in selectedItemIds) Color.rgb(42, 112, 93) else Color.rgb(17, 18, 23)
            )
            tile.foreground = if (id in selectedItemIds) ColorDrawable(Color.argb(86, 86, 210, 172)) else null
        }
    }

    private fun showSelectedItemsOnly() {
        if (selectedItemIds.isEmpty()) return
        val selectedItems = activeMedia.filter { it.id in selectedItemIds }
        if (selectedItems.isEmpty()) {
            selectedItemIds.clear()
            updateSelectionUi()
            return
        }
        activeMedia = selectedItems
        itemCount = selectedItems.size.coerceIn(1, MAX_ANDROID_ITEMS)
        prefs.edit().putInt("itemCount", itemCount).apply()
        selectedItemIds.clear()
        renderWall()
        showCenter("$itemCount selected item${if (itemCount == 1) "" else "s"}", 900)
        scheduleRandomSwap()
    }

    private fun layoutTiles(items: List<MediaItem>): List<TileRect> {
        val width = resources.displayMetrics.widthPixels
        val height = resources.displayMetrics.heightPixels
        val count = items.size
        if (count == 1) {
            val ratio = items.first().aspectRatio()
            val maxWidth = width * 0.94
            val maxHeight = height * 0.94
            var itemWidth = maxWidth
            var itemHeight = itemWidth / ratio
            if (itemHeight > maxHeight) {
                itemHeight = maxHeight
                itemWidth = itemHeight * ratio
            }
            val tileWidth = itemWidth.roundToInt()
            val tileHeight = itemHeight.roundToInt()
            return listOf(TileRect((width - tileWidth) / 2, (height - tileHeight) / 2, tileWidth, tileHeight))
        }
        var best = packRows(items, width, height, 0.7)
        var low = 0.2
        var high = 1.6
        repeat(18) {
            val mid = (low + high) / 2.0
            val candidate = packRows(items, width, height, mid)
            val bottom = candidate.maxOfOrNull { it.y + it.height } ?: 0
            if (bottom <= height) {
                best = candidate
                low = mid
            } else {
                high = mid
            }
        }
        val bottom = best.maxOfOrNull { it.y + it.height } ?: 0
        val offsetY = max(0, (height - bottom) / 2)
        return best.map { it.copy(y = it.y + offsetY) }
    }

    private fun packRows(items: List<MediaItem>, width: Int, height: Int, scale: Double): List<TileRect> {
        val targetArea = (width.toDouble() * height.toDouble() / max(1, items.size)) * scale
        val boxes = items.map { item ->
            val ratio = item.aspectRatio()
            val boxWidth = kotlin.math.sqrt(targetArea * ratio)
            val boxHeight = boxWidth / ratio
            Box(boxWidth, boxHeight)
        }
        val rects = mutableListOf<TileRect>()
        var index = 0
        var y = 0
        while (index < boxes.size) {
            val rowStart = index
            var rowWidth = 0.0
            var rowHeight = 0.0
            while (index < boxes.size && (rowWidth + boxes[index].width <= width || index == rowStart)) {
                rowWidth += boxes[index].width
                rowHeight = max(rowHeight, boxes[index].height)
                index++
            }
            val rowScale = if (rowWidth > 0) min(1.0, width / rowWidth) else 1.0
            val scaledHeight = (rowHeight * rowScale).roundToInt().coerceAtLeast(1)
            var x = ((width - rowWidth * rowScale) / 2.0).roundToInt().coerceAtLeast(0)
            for (rowIndex in rowStart until index) {
                val box = boxes[rowIndex]
                val rectWidth = (box.width * rowScale).roundToInt().coerceAtLeast(1)
                rects.add(TileRect(x, y, rectWidth, scaledHeight))
                x += rectWidth
            }
            y += scaledHeight
        }
        return rects
    }

    private fun loadTile(tile: FrameLayout, progress: ProgressBar, item: MediaItem) {
        if (item.type == "image") {
            executor.execute {
                try {
                    val bitmap = BitmapFactory.decodeStream(open(item.url).inputStream)
                    mainHandler.post {
                        tile.removeView(progress)
                        tile.addView(ImageView(this).apply {
                            scaleType = ImageView.ScaleType.CENTER_CROP
                            setImageBitmap(bitmap)
                            setOnTouchListener { _, event -> handleTileTouch(event, item.id) }
                        }, FrameLayout.LayoutParams(-1, -1))
                    }
                } catch (_: Exception) {
                    mainHandler.post { tileFailed(tile, progress) }
                }
            }
            return
        }

        executor.execute {
            val playbackUrl = if (offlineMode) {
                localOptimizedFile(item)?.toURI()?.toString() ?: item.bestRemoteVideoUrl()
            } else {
                cachedVideoUrl(item)
            }
            mainHandler.post {
                tile.removeView(progress)
                tile.addView(VideoView(this).apply {
                    setOnTouchListener { _, event -> handleTileTouch(event, item.id) }
                    setVideoURI(Uri.parse(playbackUrl))
                    setOnPreparedListener { player ->
                        player.isLooping = true
                        player.setVolume(0f, 0f)
                        start()
                    }
                    setOnErrorListener { _, _, _ ->
                        tileFailed(tile, null)
                        true
                    }
                    start()
                }, FrameLayout.LayoutParams(-1, -1))
            }
        }
    }

    private fun cachedVideoUrl(item: MediaItem): String {
        val sourceUrl = item.localDownloadSourceUrl() ?: return item.bestRemoteVideoUrl()
        val cacheFile = localOptimizedFile(item) ?: return item.bestRemoteVideoUrl()
        if (cacheFile.exists() && cacheFile.length() > 0) return cacheFile.toURI().toString()
        downloadOptimizedVideo(item, sourceUrl, cacheFile)
        return cacheFile.toURI().toString()
    }

    private fun localOptimizedFile(item: MediaItem): File? {
        val sourceUrl = item.localDownloadSourceUrl() ?: return null
        val cacheDir = File(filesDir, "optimized").apply { mkdirs() }
        return File(cacheDir, "${sha256(sourceUrl)}.mp4")
    }

    private fun MediaItem.localDownloadSourceUrl(): String? {
        if (type != "video") return null
        return optimizedUrl ?: fallbackUrl ?: url
    }

    private fun MediaItem.bestRemoteVideoUrl(): String {
        return optimizedUrl ?: fallbackUrl ?: url
    }

    private fun MediaItem.aspectRatio(): Double {
        val width = sourceWidth ?: 0
        val height = sourceHeight ?: 0
        if (width > 0 && height > 0) return (width.toDouble() / height.toDouble()).coerceIn(0.25, 4.0)
        return if (type == "video") 16.0 / 9.0 else 1.0
    }

    private fun replaceRandomItem() {
        if (activeMedia.isEmpty()) return
        val media = filteredMedia()
        if (media.size <= activeMedia.size) return
        replaceItem(activeMedia[Random.nextInt(activeMedia.size)].id)
    }

    private fun replaceItem(itemId: String) {
        val index = activeMedia.indexOfFirst { it.id == itemId }
        if (index < 0) return
        val activeIds = activeMedia.mapTo(mutableSetOf()) { it.id }
        val candidates = filteredMedia().filter { it.id !in activeIds }
        if (candidates.isEmpty()) return
        selectedItemIds.remove(itemId)
        val oldTile = tileViews.remove(itemId)
        oldTile?.let { wall.removeView(it) }
        activeMedia = activeMedia.toMutableList().also { it[index] = candidates.random() }
        renderWall()
    }

    private fun scheduleRandomSwap() {
        mainHandler.removeCallbacks(randomSwapRunnable)
        if (!randomPaused && activeMedia.isNotEmpty()) {
            mainHandler.postDelayed(randomSwapRunnable, RANDOM_SWAP_MS)
        }
    }

    private fun downloadTargets(): List<MediaItem> {
        return mediaForStats().filter { item ->
            item.localDownloadSourceUrl() != null &&
                localOptimizedFile(item)?.let { !it.exists() || it.length() <= 0 } == true
        }
    }

    private fun retryFailedDownloads() {
        val ids = failedDownloadIds.toSet()
        if (ids.isEmpty()) {
            toast("No failed downloads to retry")
            return
        }
        val targets = mediaForStats().filter { it.id in ids }
        failedDownloadIds.removeAll(ids)
        downloadVideos(targets)
    }

    private fun downloadVideos(targets: List<MediaItem>) {
        if (downloadAllInProgress) {
            toast("Download already running")
            return
        }
        downloadCancelRequested = false
        downloadTotal = targets.size
        downloadDone = 0
        downloadFailed = 0
        downloadCurrent = ""
        downloadJobs.clear()
        downloadJobs.addAll(targets.mapIndexed { index, item -> DownloadJob(item, "queued", order = index) })
        if (targets.isEmpty()) {
            downloadStatusText = "All optimized videos are already cached"
            toast(downloadStatusText)
            return
        }
        downloadAllInProgress = true
        downloadStatusText = "Downloading videos"
        showCenter("Downloading $downloadTotal videos", 1400)
        executor.execute {
            downloadJobs.forEach { job ->
                if (downloadCancelRequested) {
                    mainHandler.post { updateDownloadJob(job, "canceled") }
                    return@forEach
                }
                val item = job.item
                val sourceUrl = item.localDownloadSourceUrl()
                val targetFile = localOptimizedFile(item)
                if (sourceUrl == null || targetFile == null) return@forEach
                mainHandler.post {
                    downloadCurrent = item.path
                    updateDownloadJob(job, "downloading")
                    downloadStatusText = "Downloading videos"
                    refreshDownloadStatusIfOpen()
                }
                try {
                    downloadOptimizedVideo(item, sourceUrl, targetFile) { loaded, total ->
                        if (downloadCancelRequested) throw InterruptedException("Download stopped")
                        mainHandler.post {
                            job.bytesRead = loaded
                            job.totalBytes = total
                            job.updatedAt = System.currentTimeMillis()
                            refreshDownloadStatusIfOpenThrottled()
                        }
                    }
                    mainHandler.post {
                        updateDownloadJob(job, "finished", "")
                        downloadDone++
                        refreshDownloadStatusIfOpen()
                    }
                } catch (error: Exception) {
                    targetFile.delete()
                    mainHandler.post {
                        if (downloadCancelRequested) {
                            updateDownloadJob(job, "canceled", "")
                        } else {
                            updateDownloadJob(job, "failed", error.message ?: "Download failed")
                            failedDownloadIds.add(item.id)
                            downloadFailed++
                        }
                        refreshDownloadStatusIfOpen()
                    }
                }
            }
            mainHandler.post {
                downloadAllInProgress = false
                downloadCurrent = ""
                downloadStatusText = if (downloadCancelRequested) {
                    "Download stopped"
                } else if (downloadFailed == 0) {
                    "Finished downloading optimized videos"
                } else {
                    "Finished with $downloadFailed failed downloads"
                }
                downloadCancelRequested = false
                showCenter(downloadStatusText, 1800)
                refreshDownloadStatusIfOpen()
            }
        }
    }

    private fun refreshDownloadStatusIfOpen() {
        if (overlayScreen == "downloads" && menuVisible) showDownloadStatusScreen()
    }

    private fun refreshDownloadStatusIfOpenThrottled() {
        val now = System.currentTimeMillis()
        if (now - downloadLastUiRefresh < 350) return
        downloadLastUiRefresh = now
        refreshDownloadStatusIfOpen()
    }

    private fun downloadOptimizedVideo(
        item: MediaItem,
        sourceUrl: String,
        cacheFile: File,
        progress: ((Long, Long) -> Unit)? = null
    ) {
        showCenter("Downloading ${item.name}", 900)
        cacheFile.parentFile?.mkdirs()
        val tempFile = File(cacheFile.parentFile, "${cacheFile.name}.part")
        tempFile.delete()
        try {
            val connection = open(sourceUrl)
            val totalBytes = connection.contentLengthLong.takeIf { it > 0 } ?: 0L
            var loadedBytes = 0L
            connection.inputStream.use { input ->
                FileOutputStream(tempFile).use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        loadedBytes += read
                        progress?.invoke(loadedBytes, totalBytes)
                    }
                }
            }
            if (cacheFile.exists()) cacheFile.delete()
            if (!tempFile.renameTo(cacheFile)) {
                tempFile.copyTo(cacheFile, overwrite = true)
                tempFile.delete()
            }
        } catch (error: Exception) {
            tempFile.delete()
            throw error
        }
    }

    private fun tileFailed(tile: FrameLayout, progress: ProgressBar?) {
        progress?.let { tile.removeView(it) }
        tile.addView(TextView(this).apply {
            text = "Failed"
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        }, FrameLayout.LayoutParams(-1, -1))
    }

    private fun changeItemCount(delta: Int) {
        val maxItems = minOf(MAX_ANDROID_ITEMS, max(1, filteredMedia().size))
        val nextCount = (itemCount + delta).coerceIn(1, maxItems)
        if (nextCount == itemCount) return
        itemCount = nextCount
        prefs.edit().putInt("itemCount", itemCount).apply()
        activeMedia = resizeActiveMedia(itemCount)
        renderWall()
        showCenter("$itemCount item${if (itemCount == 1) "" else "s"}", 900)
        scheduleRandomSwap()
    }

    private fun showCenter(message: String, durationMs: Long = 0) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { showCenter(message, durationMs) }
            return
        }
        splash.text = message
        splash.visibility = View.VISIBLE
        if (durationMs > 0) {
            mainHandler.postDelayed({ splash.visibility = View.GONE }, durationMs)
        }
    }

    private fun toast(message: String) {
        showCenter(message, 1200)
    }

    private fun sha256(text: String): String {
        return MessageDigest.getInstance("SHA-256")
            .digest(text.toByteArray())
            .joinToString("") { "%02x".format(it) }
    }

    private fun cacheStats(): CacheStats {
        val mediaForStats = mediaForStats()
        val knownVideos = mediaForStats.count { it.localDownloadSourceUrl() != null }
        val cachedVideos = mediaForStats.count { it.type == "video" && localOptimizedFile(it)?.exists() == true }
        val cacheDir = File(filesDir, "optimized")
        val bytes = cacheDir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
        return CacheStats(knownVideos, cachedVideos, bytes)
    }

    private fun cleanupLocalDownloads(media: List<MediaItem>) {
        val cacheDir = File(filesDir, "optimized")
        if (!cacheDir.exists()) return
        val validNames = media
            .mapNotNull { it.localDownloadSourceUrl() }
            .map { "${sha256(it)}.mp4" }
            .toSet()
        cacheDir.walkTopDown()
            .filter { it.isFile && it.name !in validNames && !it.name.endsWith(".part") }
            .forEach { it.delete() }
        cacheDir.walkTopDown()
            .filter { it.isFile && it.name.endsWith(".part") }
            .forEach { it.delete() }
    }

    private fun mediaForStats(): List<MediaItem> {
        return allMedia.takeIf { it.isNotEmpty() } ?: run {
            val savedJson = prefs.getString("lastMediaJson", null) ?: ""
            try {
                parseMediaArray(JSONObject(savedJson).optJSONArray("media") ?: JSONArray())
            } catch (_: Exception) {
                emptyList()
            }
        }
    }

    private fun formatBytes(bytes: Long): String {
        if (bytes <= 0L) return "0 MB"
        return String.format(Locale.US, "%.1f MB", bytes / 1024.0 / 1024.0)
    }

    data class MediaItem(
        val id: String,
        val name: String,
        val type: String,
        val path: String,
        val url: String,
        val optimizedUrl: String?,
        val fallbackUrl: String?,
        val sourceWidth: Int?,
        val sourceHeight: Int?
    )

    data class SubfolderItem(val name: String, val path: String)
    data class DownloadJob(
        val item: MediaItem,
        var status: String,
        var bytesRead: Long = 0,
        var totalBytes: Long = 0,
        var error: String = "",
        var order: Int = 0,
        var updatedAt: Long = System.currentTimeMillis()
    ) {
        fun percent(): Int {
            if (totalBytes <= 0L) return if (status == "finished") 100 else 0
            return ((bytesRead * 100) / totalBytes).coerceIn(0, 100).toInt()
        }
    }
    data class TileRect(val x: Int, val y: Int, val width: Int, val height: Int)
    data class Box(val width: Double, val height: Double)
    data class MediaResult(val media: List<MediaItem>, val subfolders: List<SubfolderItem>, val rawJson: String)
    data class CacheStats(val knownVideos: Int, val cachedVideos: Int, val bytes: Long)
}
