package com.chathub.offline

import android.Manifest
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.*
import com.google.android.gms.tasks.Tasks
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

class NearbyConnectionsModule(
    private val context: ReactApplicationContext
) : ReactContextBaseJavaModule(context) {

    private val client = Nearby.getConnectionsClient(context)
    private val serviceId = "com.chathub.offline"
    private val strategy = Strategy.P2P_CLUSTER

    private val discoveredEndpoints = mutableMapOf<String, String>()
    private val endpointNames = mutableMapOf<String, String>()
    private val outgoingRequests = mutableSetOf<String>()
    private val connectedEndpoints = mutableSetOf<String>()
    private val incomingFilePayloads = mutableMapOf<Long, Payload>()
    private val incomingFileMetadata = mutableMapOf<Long, JSONObject>()
    private val completedFilePayloads = mutableSetOf<Long>()
    private val outgoingFileMessageIds = mutableMapOf<Long, String>()
    private val outgoingTemporaryFiles = mutableMapOf<Long, File>()
    private val filePayloadLock = Any()

    @Volatile
    private var isDiscovering = false

    @Volatile
    private var isAdvertising = false

    override fun getName(): String = "NearbyConnections"

    @ReactMethod
    fun playScanStartSound(promise: Promise) {
        try {
            val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 35)
            if (!tone.startTone(ToneGenerator.TONE_PROP_BEEP, 110)) {
                tone.release()
                promise.resolve(false)
                return
            }
            Handler(Looper.getMainLooper()).postDelayed({
                tone.release()
                promise.resolve(true)
            }, 140)
        } catch (error: Exception) {
            promise.reject("SCAN_SOUND_FAILED", error.message, error)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Int) = Unit

    private fun emit(event: String, data: WritableMap) {
        if (!context.hasActiveReactInstance()) return

        context
            .getJSModule(
                DeviceEventManagerModule.RCTDeviceEventEmitter::class.java
            )
            .emit(event, data)
    }

    private fun finishIncomingFile(endpointId: String, payloadId: Long) {
        val transfer = synchronized(filePayloadLock) {
            val payload = incomingFilePayloads[payloadId]
            val metadata = incomingFileMetadata[payloadId]
            if (payload == null || metadata == null || payloadId !in completedFilePayloads) {
                null
            } else {
                incomingFilePayloads.remove(payloadId)
                incomingFileMetadata.remove(payloadId)
                completedFilePayloads.remove(payloadId)
                payload to metadata
            }
        } ?: return

        try {
            val originalName = transfer.second.optString("fileName", "shared-file")
            val safeName = originalName
                .substringAfterLast('/')
                .substringAfterLast('\\')
                .replace(Regex("[^A-Za-z0-9._-]"), "_")
                .take(120)
                .ifBlank { "shared-file" }
            val sharedDirectory = File(context.filesDir, "shared").apply { mkdirs() }
            val savedFile = File(sharedDirectory, "${payloadId}_$safeName")
            val receivedFile = transfer.first.asFile()
                ?: throw IllegalStateException("Received payload is not a file")
            val receivedUri = receivedFile.asUri()
                ?: throw IllegalStateException("Could not access received file URI")
            val input = context.contentResolver.openInputStream(receivedUri)
                ?: throw IllegalStateException("Could not open received file")
            input.use { source ->
                FileOutputStream(savedFile).use { destination -> source.copyTo(destination) }
            }
            context.contentResolver.delete(receivedUri, null, null)

            val data = Arguments.createMap()
            data.putString("endpointId", endpointId)
            data.putString("payloadId", payloadId.toString())
            data.putString("messageId", transfer.second.optString("messageId"))
            data.putString("fileName", originalName)
            data.putString("mimeType", transfer.second.optString("mimeType", "application/octet-stream"))
            data.putString("kind", transfer.second.optString("kind", "file"))
            data.putString("uri", Uri.fromFile(savedFile).toString())
            data.putDouble("sentAt", transfer.second.optDouble("sentAt", System.currentTimeMillis().toDouble()))
            data.putString("senderName", transfer.second.optString("senderName", "Nearby device"))
            data.putString("senderId", transfer.second.optString("senderId"))
            synchronized(endpointNames) {
                data.putString("endpointName", endpointNames[endpointId] ?: discoveredEndpoints[endpointId] ?: "Nearby device")
            }
            emit("fileReceived", data)
        } catch (error: Exception) {
            val data = Arguments.createMap()
            data.putString("endpointId", endpointId)
            data.putString("payloadId", payloadId.toString())
            data.putString("message", error.message ?: "Could not save received file")
            emit("fileTransferFailed", data)
        }
    }

    private fun hasPermissions(): Boolean {
        val permissions = mutableListOf<String>()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            permissions.add(Manifest.permission.BLUETOOTH_SCAN)
            permissions.add(Manifest.permission.BLUETOOTH_CONNECT)
            permissions.add(Manifest.permission.BLUETOOTH_ADVERTISE)
        } else {
            permissions.add(Manifest.permission.ACCESS_FINE_LOCATION)
        }

        return permissions.all {
            context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun requirePermissions(promise: Promise): Boolean {
        if (!hasPermissions()) {
            promise.reject(
                "PERMISSION_REQUIRED",
                "Nearby Connections permissions are required."
            )
            return false
        }
        return true
    }

    // Connection lifecycle
    private val lifecycleCallback = object : ConnectionLifecycleCallback() {

        override fun onConnectionInitiated(
            endpointId: String,
            info: ConnectionInfo
        ) {
            synchronized(endpointNames) {
                endpointNames[endpointId] = info.endpointName
            }
            val data = Arguments.createMap()
            data.putString("endpointId", endpointId)
            data.putString("endpointName", info.endpointName)
            data.putString("authenticationToken", info.authenticationToken)
            val isOutgoing = synchronized(outgoingRequests) {
                endpointId in outgoingRequests
            }
            data.putBoolean("isOutgoing", isOutgoing)
            emit("connectionRequest", data)
        }

        override fun onConnectionResult(
            endpointId: String,
            result: ConnectionResolution
        ) {
            val connected =
                result.status.statusCode == ConnectionsStatusCodes.STATUS_OK

            synchronized(connectedEndpoints) {
                if (connected) {
                    connectedEndpoints.add(endpointId)
                } else {
                    connectedEndpoints.remove(endpointId)
                }
            }
            synchronized(outgoingRequests) {
                outgoingRequests.remove(endpointId)
            }

            val data = Arguments.createMap()
            data.putString("endpointId", endpointId)
            data.putString(
                "status",
                if (connected) "connected" else "failed"
            )
            synchronized(endpointNames) {
                data.putString("endpointName", endpointNames[endpointId] ?: discoveredEndpoints[endpointId] ?: "Nearby device")
            }
            emit("connectionChanged", data)
        }

        override fun onDisconnected(endpointId: String) {
            synchronized(connectedEndpoints) {
                connectedEndpoints.remove(endpointId)
            }
            synchronized(outgoingRequests) {
                outgoingRequests.remove(endpointId)
            }

            val data = Arguments.createMap()
            data.putString("endpointId", endpointId)
            data.putString("status", "disconnected")
            synchronized(endpointNames) {
                data.putString("endpointName", endpointNames[endpointId] ?: discoveredEndpoints[endpointId] ?: "Nearby device")
            }
            emit("connectionChanged", data)
        }
    }

    // Discovery callbacks
    private val discoveryCallback = object : EndpointDiscoveryCallback() {

        override fun onEndpointFound(
            endpointId: String,
            info: DiscoveredEndpointInfo
        ) {
            synchronized(discoveredEndpoints) {
                discoveredEndpoints[endpointId] = info.endpointName
            }
            synchronized(endpointNames) {
                endpointNames[endpointId] = info.endpointName
            }

            val data = Arguments.createMap()
            data.putString("endpointId", endpointId)
            data.putString("endpointName", info.endpointName)
            emit("deviceFound", data)
        }

        override fun onEndpointLost(endpointId: String) {
            synchronized(discoveredEndpoints) {
                discoveredEndpoints.remove(endpointId)
            }

            val data = Arguments.createMap()
            data.putString("endpointId", endpointId)
            emit("deviceLost", data)
        }
    }

    // Message payload callbacks
    private val payloadCallback = object : PayloadCallback() {

        override fun onPayloadReceived(
            endpointId: String,
            payload: Payload
        ) {
            if (payload.type == Payload.Type.FILE) {
                synchronized(filePayloadLock) {
                    incomingFilePayloads[payload.id] = payload
                }
                finishIncomingFile(endpointId, payload.id)
                return
            }
            if (payload.type != Payload.Type.BYTES) return

            val message = payload.asBytes()?.toString(Charsets.UTF_8) ?: return
            try {
                val metadata = JSONObject(message)
                if (metadata.optString("type") == "file-metadata") {
                    val filePayloadId = metadata.optLong("payloadId", -1)
                    if (filePayloadId >= 0) {
                        synchronized(filePayloadLock) {
                            incomingFileMetadata[filePayloadId] = metadata
                        }
                        finishIncomingFile(endpointId, filePayloadId)
                    }
                    return
                }
            } catch (_: Exception) {
                // Plain text messages are allowed and are handled below.
            }

            val data = Arguments.createMap()
            data.putString("endpointId", endpointId)
            data.putString("message", message)
            synchronized(endpointNames) {
                data.putString("endpointName", endpointNames[endpointId] ?: discoveredEndpoints[endpointId] ?: "Nearby device")
            }
            emit("messageReceived", data)
        }

        override fun onPayloadTransferUpdate(
            endpointId: String,
            update: PayloadTransferUpdate
        ) {
            if (update.status == PayloadTransferUpdate.Status.SUCCESS) {
                val temporaryFile = synchronized(filePayloadLock) {
                    outgoingTemporaryFiles.remove(update.payloadId)
                }
                temporaryFile?.delete()
                synchronized(filePayloadLock) {
                    if (incomingFilePayloads[update.payloadId]?.type == Payload.Type.FILE) {
                        completedFilePayloads.add(update.payloadId)
                    }
                }
                finishIncomingFile(endpointId, update.payloadId)
                val data = Arguments.createMap()
                data.putString("endpointId", endpointId)
                data.putString("payloadId", update.payloadId.toString())
                synchronized(filePayloadLock) {
                    outgoingFileMessageIds.remove(update.payloadId)?.let { data.putString("messageId", it) }
                }
                emit("transferComplete", data)
            } else if (
                update.status == PayloadTransferUpdate.Status.FAILURE ||
                update.status == PayloadTransferUpdate.Status.CANCELED
            ) {
                val temporaryFile = synchronized(filePayloadLock) {
                    outgoingTemporaryFiles.remove(update.payloadId)
                }
                temporaryFile?.delete()
                val data = Arguments.createMap()
                data.putString("endpointId", endpointId)
                data.putString("payloadId", update.payloadId.toString())
                synchronized(filePayloadLock) {
                    outgoingFileMessageIds.remove(update.payloadId)?.let { data.putString("messageId", it) }
                }
                emit("transferFailed", data)
            }
        }
    }

    // Start discovery; avoid duplicate requests from this module.
    @ReactMethod
    fun startDiscovery(promise: Promise) {
        if (!requirePermissions(promise)) return

        synchronized(this) {
            if (isDiscovering) {
                promise.resolve(true)
                return
            }
            isDiscovering = true
        }

        val options = DiscoveryOptions.Builder()
            .setStrategy(strategy)
            .build()

        client.startDiscovery(serviceId, discoveryCallback, options)
            .addOnSuccessListener {
                promise.resolve(true)
            }
            .addOnFailureListener { error ->
                synchronized(this) {
                    isDiscovering = false
                }
                promise.reject("DISCOVERY_FAILED", error.message, error)
            }
    }

    @ReactMethod
    fun stopDiscovery(promise: Promise) {
        try {
            client.stopDiscovery()
            synchronized(this) {
                isDiscovering = false
            }
            promise.resolve(true)
        } catch (error: Exception) {
            promise.reject("STOP_DISCOVERY_FAILED", error.message, error)
        }
    }

    // Start advertising
    @ReactMethod
    fun startAdvertising(deviceName: String, promise: Promise) {
        if (!requirePermissions(promise)) return

        synchronized(this) {
            if (isAdvertising) {
                promise.resolve(true)
                return
            }
            isAdvertising = true
        }

        val options = AdvertisingOptions.Builder()
            .setStrategy(strategy)
            .build()

        client.startAdvertising(
            deviceName,
            serviceId,
            lifecycleCallback,
            options
        )
            .addOnSuccessListener {
                promise.resolve(true)
            }
            .addOnFailureListener { error ->
                synchronized(this) {
                    isAdvertising = false
                }
                promise.reject("ADVERTISING_FAILED", error.message, error)
            }
    }

    @ReactMethod
    fun stopAdvertising(promise: Promise) {
        try {
            client.stopAdvertising()
            synchronized(this) {
                isAdvertising = false
            }
            promise.resolve(true)
        } catch (error: Exception) {
            promise.reject("STOP_ADVERTISING_FAILED", error.message, error)
        }
    }

    // Request connection
    @ReactMethod
    fun requestConnection(
        endpointId: String,
        deviceName: String,
        promise: Promise
    ) {
        if (!requirePermissions(promise)) return

        synchronized(outgoingRequests) {
            outgoingRequests.add(endpointId)
        }
        synchronized(endpointNames) {
            endpointNames[endpointId] = deviceName
        }

        client.requestConnection(deviceName, endpointId, lifecycleCallback)
            .addOnSuccessListener {
                promise.resolve(true)
            }
            .addOnFailureListener { error ->
                synchronized(outgoingRequests) {
                    outgoingRequests.remove(endpointId)
                }
                promise.reject("CONNECTION_FAILED", error.message, error)
            }
    }

    // Accept connection
    @ReactMethod
    fun acceptConnection(endpointId: String, promise: Promise) {
        if (!requirePermissions(promise)) return

        client.acceptConnection(endpointId, payloadCallback)
            .addOnSuccessListener {
                promise.resolve(true)
            }
            .addOnFailureListener { error ->
                promise.reject("ACCEPT_FAILED", error.message, error)
            }
    }

    // Reject connection
    @ReactMethod
    fun rejectConnection(endpointId: String, promise: Promise) {
        client.rejectConnection(endpointId)
            .addOnSuccessListener {
                promise.resolve(true)
            }
            .addOnFailureListener { error ->
                promise.reject("REJECT_FAILED", error.message, error)
            }
    }

    // Send text message
    @ReactMethod
    fun sendMessage(
        endpointId: String,
        message: String,
        promise: Promise
    ) {
        val connected = synchronized(connectedEndpoints) {
            endpointId in connectedEndpoints
        }

        if (!connected) {
            promise.reject("NOT_CONNECTED", "Device is not connected.")
            return
        }

        val payload = Payload.fromBytes(message.toByteArray(Charsets.UTF_8))

        client.sendPayload(endpointId, payload)
            .addOnSuccessListener {
                promise.resolve(true)
            }
            .addOnFailureListener { error ->
                promise.reject("SEND_FAILED", error.message, error)
            }
    }

    @ReactMethod
    fun sendFile(
        endpointId: String,
        fileUri: String,
        messageId: String,
        fileName: String,
        mimeType: String,
        kind: String,
        sentAt: Double,
        senderName: String,
        senderId: String,
        promise: Promise
    ) {
        val connected = synchronized(connectedEndpoints) {
            endpointId in connectedEndpoints
        }
        if (!connected) {
            promise.reject("NOT_CONNECTED", "Device is not connected.")
            return
        }

        var temporarySourceFile: File? = null
        try {
            val parsedUri = Uri.parse(fileUri)
            val file = when (parsedUri.scheme?.lowercase()) {
                "content" -> {
                    val temporaryFile = File.createTempFile("chathub-send-", ".tmp", context.cacheDir)
                    temporarySourceFile = temporaryFile
                    val input = context.contentResolver.openInputStream(parsedUri)
                        ?: throw IllegalStateException("Could not open selected file")
                    input.use { source ->
                        FileOutputStream(temporaryFile).use { destination -> source.copyTo(destination) }
                    }
                    temporaryFile
                }
                "file" -> File(parsedUri.path ?: throw IllegalArgumentException("Invalid file URI"))
                null, "" -> File(fileUri)
                else -> throw IllegalArgumentException("Unsupported file URI")
            }
            if (!file.isFile) {
                if (parsedUri.scheme.equals("content", ignoreCase = true)) file.delete()
                promise.reject("FILE_NOT_FOUND", "Selected file is not available.")
                return
            }
            if (file.length() > 100L * 1024L * 1024L) {
                if (parsedUri.scheme.equals("content", ignoreCase = true)) file.delete()
                promise.reject("FILE_TOO_LARGE", "Files must be 100 MB or smaller.")
                return
            }

            val filePayload = Payload.fromFile(file)
            synchronized(filePayloadLock) {
                outgoingFileMessageIds[filePayload.id] = messageId
                if (parsedUri.scheme.equals("content", ignoreCase = true)) {
                    outgoingTemporaryFiles[filePayload.id] = file
                    temporarySourceFile = null
                }
            }
            val metadata = JSONObject()
                .put("type", "file-metadata")
                .put("payloadId", filePayload.id)
                .put("messageId", messageId)
                .put("fileName", fileName)
                .put("mimeType", mimeType)
                .put("kind", kind)
                .put("sentAt", sentAt)
                .put("senderName", senderName)
                .put("senderId", senderId)
            val metadataPayload = Payload.fromBytes(metadata.toString().toByteArray(Charsets.UTF_8))

            Tasks.whenAll(
                client.sendPayload(endpointId, metadataPayload),
                client.sendPayload(endpointId, filePayload)
            )
                .addOnSuccessListener { promise.resolve(filePayload.id.toString()) }
                .addOnFailureListener { error ->
                    synchronized(filePayloadLock) {
                        outgoingFileMessageIds.remove(filePayload.id)
                        outgoingTemporaryFiles.remove(filePayload.id)?.delete()
                    }
                    promise.reject("FILE_SEND_FAILED", error.message, error)
                }
        } catch (error: Exception) {
            temporarySourceFile?.delete()
            promise.reject("FILE_SEND_FAILED", error.message, error)
        }
    }

    // Disconnect
    @ReactMethod
    fun disconnect(endpointId: String, promise: Promise) {
        client.disconnectFromEndpoint(endpointId)

        synchronized(connectedEndpoints) {
            connectedEndpoints.remove(endpointId)
        }
        promise.resolve(true)
    }

    // Stop all Nearby operations
    @ReactMethod
    fun stopAll(promise: Promise) {
        try {
            client.stopDiscovery()
            client.stopAdvertising()
            client.stopAllEndpoints()

            synchronized(this) {
                isDiscovering = false
                isAdvertising = false
            }

            synchronized(discoveredEndpoints) {
                discoveredEndpoints.clear()
            }
            synchronized(endpointNames) {
                endpointNames.clear()
            }
            synchronized(outgoingRequests) {
                outgoingRequests.clear()
            }

            synchronized(connectedEndpoints) {
                connectedEndpoints.clear()
            }

            promise.resolve(true)
        } catch (error: Exception) {
            promise.reject("STOP_ALL_FAILED", error.message, error)
        }
    }
}
