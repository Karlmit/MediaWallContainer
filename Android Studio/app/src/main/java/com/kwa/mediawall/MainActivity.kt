package com.kwa.mediawall

import android.app.Activity
import android.content.res.Configuration
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
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
    private var overlayView: View? = null

    private var serverUrl = ""
    private var password = ""
    private var sessionCookie = ""
    private var itemCount = 6
    private var localOptimizedCache = false
    private var pinEnabled = false
    private var pinCode = ""
    private var allMedia = emptyList<MediaItem>()
    private var activeMedia = emptyList<MediaItem>()
    private var touchStartY = 0f
    private var touchLastY = 0f
    private var touchStartTime = 0L
    private var touchChangedItemCount = false
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
        root.addView(wall, FrameLayout.LayoutParams(-1, -1))
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
        val handled = handleWallTouch(event)
        if (event.actionMasked == MotionEvent.ACTION_UP) {
            val dy = kotlin.math.abs(event.y - touchStartY)
            val quickEnough = System.currentTimeMillis() - touchStartTime < 900
            if (!touchChangedItemCount && quickEnough && dy < 35) replaceItem(itemId)
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
                    append("${allMedia.size} media items")
                    if (serverUrl.isNotBlank()) append("\n$serverUrl")
                }
                setTextColor(Color.rgb(166, 167, 173))
                textSize = 14f
                setPadding(0, 0, 0, 14)
            })
            addView(button("Connection settings") { showSetupScreen() })
            addView(button(if (randomPaused) "Resume randomness" else "Pause randomness") {
                randomPaused = !randomPaused
                if (randomPaused) {
                    mainHandler.removeCallbacks(randomSwapRunnable)
                    toast("Randomness paused")
                } else {
                    scheduleRandomSwap()
                    toast("Randomness resumed")
                }
                showMainMenu()
            })
            addView(button("Download all optimized videos") {
                downloadAllOptimizedVideos()
                showDownloadStatusScreen()
            })
            addView(button("Download status") { showDownloadStatusScreen() })
            addView(button("Reconnect") {
                clearOverlay()
                menuVisible = false
                connectAndLoad()
            })
            addView(button("Open offline") {
                clearOverlay()
                menuVisible = false
                if (!openOfflineMode()) {
                    toast("No cached offline videos yet")
                    showMainMenu()
                }
            })
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

    private fun showSetupScreen() {
        menuVisible = true
        overlayScreen = "setup"
        val panel = panel("Connection settings")
        val urlInput = input("Docker URL, for example http://192.168.1.10:3060", false).apply {
            setText(serverUrl)
        }
        val passwordInput = input("Docker password", true).apply {
            setText(password)
        }
        val cacheToggle = CheckBox(this).apply {
            text = "Download optimized videos into private app storage"
            setTextColor(Color.WHITE)
            isChecked = localOptimizedCache
        }
        val pinToggle = CheckBox(this).apply {
            text = "Lock app behind PIN"
            setTextColor(Color.WHITE)
            isChecked = pinEnabled
        }
        val pinInput = numericPinInput("PIN").apply {
            setText(pinCode)
        }
        panel.addView(urlInput)
        panel.addView(passwordInput)
        panel.addView(cacheToggle)
        panel.addView(pinToggle)
        panel.addView(pinInput)
        panel.addView(button("Connect") {
            serverUrl = normalizeServerUrl(urlInput.text.toString())
            password = passwordInput.text.toString()
            localOptimizedCache = cacheToggle.isChecked
            pinEnabled = pinToggle.isChecked
            pinCode = pinInput.text.toString()
            prefs.edit()
                .putString("serverUrl", serverUrl)
                .putString("password", password)
                .putBoolean("localOptimizedCache", localOptimizedCache)
                .putBoolean("pinEnabled", pinEnabled)
                .putString("pinCode", pinCode)
                .apply()
            clearOverlay()
            menuVisible = false
            connectAndLoad()
        })
        panel.addView(button("Back to menu") { showMainMenu() })
        showOverlay(panel)
    }

    private fun showDownloadStatusScreen() {
        menuVisible = true
        overlayScreen = "downloads"
        showOverlay(panel("Download status").apply {
            val stats = cacheStats()
            addView(TextView(context).apply {
                text = buildString {
                    append("Status: $downloadStatusText\n")
                    if (downloadCurrent.isNotBlank()) append("Current: $downloadCurrent\n")
                    if (downloadTotal > 0) append("Progress: $downloadDone / $downloadTotal, failed $downloadFailed\n")
                    append("\n")
                    append("Optimized video cache\n")
                    append("${stats.cachedVideos} / ${stats.knownVideos} optimized videos cached\n")
                    append("${formatBytes(stats.bytes)} stored in app-private storage\n")
                    append("\n")
                    append("Only /optimized videos are downloaded. Originals and fallback streams are not saved locally.\n")
                    append("Cached files are inside Android app storage and should not appear in the normal device file browser.")
                }
                setTextColor(Color.WHITE)
                textSize = 15f
                setPadding(0, 0, 0, 16)
            })
            addView(button("Download all optimized videos") {
                downloadAllOptimizedVideos()
                showDownloadStatusScreen()
            })
            addView(button("Clear private video cache") {
                File(filesDir, "optimized").deleteRecursively()
                downloadStatusText = "Private optimized cache cleared"
                downloadCurrent = ""
                downloadTotal = 0
                downloadDone = 0
                downloadFailed = 0
                toast("Private cache cleared")
                showDownloadStatusScreen()
            })
            addView(button("Open offline") {
                clearOverlay()
                menuVisible = false
                if (!openOfflineMode()) {
                    toast("No cached offline videos yet")
                    showDownloadStatusScreen()
                }
            })
            addView(button("Back to menu") { showMainMenu() })
        })
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
        clearOverlay()
        val scroll = ScrollView(this).apply {
            setPadding(0, 20, 0, 20)
            addView(content)
        }
        overlayView = scroll
        root.addView(scroll, centeredPanelParams())
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
                mainHandler.post {
                    offlineMode = false
                    allMedia = loaded.media
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
        return MediaResult(parseMediaArray(array), text)
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

    private fun openOfflineMode(): Boolean {
        val savedJson = prefs.getString("lastMediaJson", null) ?: return false
        return try {
            val result = JSONObject(savedJson)
            val media = parseMediaArray(result.optJSONArray("media") ?: JSONArray())
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
        if (allMedia.isEmpty()) return emptyList()
        return allMedia.shuffled().take(minOf(itemCount, MAX_ANDROID_ITEMS, allMedia.size))
    }

    private fun renderWall() {
        wall.removeAllViews()
        if (activeMedia.isEmpty()) {
            showCenter("No media found")
            return
        }
        layoutTiles(activeMedia).forEachIndexed { index, rect ->
            val item = activeMedia[index]
            val tile = FrameLayout(this).apply {
                setBackgroundColor(Color.rgb(17, 18, 23))
                setOnTouchListener { _, event -> handleTileTouch(event, item.id) }
            }
            val progress = ProgressBar(this)
            tile.addView(progress, FrameLayout.LayoutParams(56, 56, Gravity.CENTER))
            wall.addView(tile, FrameLayout.LayoutParams(rect.width, rect.height).apply {
                leftMargin = rect.x
                topMargin = rect.y
            })
            loadTile(tile, progress, item)
        }
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
            } else if (localOptimizedCache) {
                cachedVideoUrl(item)
            } else {
                item.bestRemoteVideoUrl()
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
        val sourceUrl = item.optimizedUrl ?: return item.bestRemoteVideoUrl()
        val cacheFile = localOptimizedFile(item) ?: return item.bestRemoteVideoUrl()
        if (cacheFile.exists() && cacheFile.length() > 0) return cacheFile.toURI().toString()
        downloadOptimizedVideo(item, sourceUrl, cacheFile)
        return cacheFile.toURI().toString()
    }

    private fun localOptimizedFile(item: MediaItem): File? {
        val sourceUrl = item.optimizedUrl ?: return null
        val cacheDir = File(filesDir, "optimized").apply { mkdirs() }
        return File(cacheDir, "${sha256(sourceUrl)}.mp4")
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
        if (allMedia.size <= activeMedia.size) return
        replaceItem(activeMedia[Random.nextInt(activeMedia.size)].id)
    }

    private fun replaceItem(itemId: String) {
        val index = activeMedia.indexOfFirst { it.id == itemId }
        if (index < 0) return
        val activeIds = activeMedia.mapTo(mutableSetOf()) { it.id }
        val candidates = allMedia.filter { it.id !in activeIds }
        if (candidates.isEmpty()) return
        activeMedia = activeMedia.toMutableList().also { it[index] = candidates.random() }
        renderWall()
    }

    private fun scheduleRandomSwap() {
        mainHandler.removeCallbacks(randomSwapRunnable)
        if (!randomPaused && activeMedia.isNotEmpty()) {
            mainHandler.postDelayed(randomSwapRunnable, RANDOM_SWAP_MS)
        }
    }

    private fun downloadAllOptimizedVideos() {
        if (downloadAllInProgress) {
            toast("Optimized download already running")
            return
        }
        val media = mediaForStats()
        val targets = media.filter { item ->
            item.type == "video" &&
                item.optimizedUrl != null &&
                localOptimizedFile(item)?.let { !it.exists() || it.length() <= 0 } == true
        }
        downloadTotal = targets.size
        downloadDone = 0
        downloadFailed = 0
        downloadCurrent = ""
        if (targets.isEmpty()) {
            downloadStatusText = "All optimized videos are already cached"
            toast(downloadStatusText)
            return
        }
        downloadAllInProgress = true
        downloadStatusText = "Downloading optimized videos"
        showCenter("Downloading $downloadTotal optimized videos", 1400)
        executor.execute {
            targets.forEach { item ->
                val sourceUrl = item.optimizedUrl
                val targetFile = localOptimizedFile(item)
                if (sourceUrl == null || targetFile == null) return@forEach
                mainHandler.post {
                    downloadCurrent = item.path
                    downloadStatusText = "Downloading optimized videos"
                    refreshDownloadStatusIfOpen()
                }
                try {
                    downloadOptimizedVideo(item, sourceUrl, targetFile)
                    mainHandler.post {
                        downloadDone++
                        refreshDownloadStatusIfOpen()
                    }
                } catch (_: Exception) {
                    targetFile.delete()
                    mainHandler.post {
                        downloadFailed++
                        refreshDownloadStatusIfOpen()
                    }
                }
            }
            mainHandler.post {
                downloadAllInProgress = false
                downloadCurrent = ""
                downloadStatusText = if (downloadFailed == 0) {
                    "Finished downloading optimized videos"
                } else {
                    "Finished with $downloadFailed failed downloads"
                }
                showCenter(downloadStatusText, 1800)
                refreshDownloadStatusIfOpen()
            }
        }
    }

    private fun refreshDownloadStatusIfOpen() {
        if (overlayScreen == "downloads" && menuVisible) showDownloadStatusScreen()
    }

    private fun downloadOptimizedVideo(item: MediaItem, sourceUrl: String, cacheFile: File) {
        showCenter("Downloading ${item.name}", 900)
        cacheFile.parentFile?.mkdirs()
        val tempFile = File(cacheFile.parentFile, "${cacheFile.name}.part")
        tempFile.delete()
        val connection = open(sourceUrl)
        connection.inputStream.use { input ->
            FileOutputStream(tempFile).use { output -> input.copyTo(output) }
        }
        if (cacheFile.exists()) cacheFile.delete()
        if (!tempFile.renameTo(cacheFile)) {
            tempFile.copyTo(cacheFile, overwrite = true)
            tempFile.delete()
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
        val maxItems = minOf(MAX_ANDROID_ITEMS, max(1, allMedia.size))
        itemCount = (itemCount + delta).coerceIn(1, maxItems)
        prefs.edit().putInt("itemCount", itemCount).apply()
        activeMedia = pickActiveMedia()
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
        val knownVideos = mediaForStats.count { it.type == "video" && it.optimizedUrl != null }
        val cachedVideos = mediaForStats.count { it.type == "video" && localOptimizedFile(it)?.exists() == true }
        val cacheDir = File(filesDir, "optimized")
        val bytes = cacheDir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
        return CacheStats(knownVideos, cachedVideos, bytes)
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

    data class TileRect(val x: Int, val y: Int, val width: Int, val height: Int)
    data class Box(val width: Double, val height: Double)
    data class MediaResult(val media: List<MediaItem>, val rawJson: String)
    data class CacheStats(val knownVideos: Int, val cachedVideos: Int, val bytes: Long)
}
