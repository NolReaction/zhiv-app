package ru.zhiv.mochlik.lab

import android.content.ContentValues
import android.content.Context
import android.database.DatabaseUtils
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.UUID
import java.util.concurrent.Executors

/** Bounded atomic command receipts; credentials are stored separately in the session vault. */
@CapacitorPlugin(name = "MochlikStorage")
class MochlikStoragePlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor()
    private var helper: ReceiptDatabase? = null

    override fun load() {
        helper = ReceiptDatabase(context)
    }

    override fun handleOnDestroy() {
        worker.execute { helper?.close() }
        worker.shutdown()
        super.handleOnDestroy()
    }

    private class ReceiptDatabase(context: Context) : SQLiteOpenHelper(
        context,
        "${context.noBackupFilesDir.absolutePath}/mochlik-receipts.sqlite",
        null,
        2,
    ) {
        init {
            setWriteAheadLoggingEnabled(true)
        }

        override fun onConfigure(database: SQLiteDatabase) {
            database.execSQL("PRAGMA synchronous=FULL")
        }

        override fun onCreate(database: SQLiteDatabase) {
            database.execSQL("CREATE TABLE receipts(owner TEXT NOT NULL, receipt_key TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner, receipt_key))")
            createJournals(database)
        }

        private fun createJournals(database: SQLiteDatabase) {
            database.execSQL("CREATE TABLE journals(owner TEXT NOT NULL, journal_key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner, journal_key))")
        }

        override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            if (oldVersion == 1 && newVersion == 2) {
                createJournals(database)
            } else {
                error("Unknown storage migration")
            }
        }
    }

    private fun perform(call: PluginCall, operation: (SQLiteDatabase) -> JSObject) {
        worker.execute {
            try {
                call.resolve(operation(checkNotNull(helper).writableDatabase))
            } catch (_: Exception) {
                call.reject("Не удалось прочитать или сохранить очередь устройства", "STORAGE_FAILED")
            }
        }
    }

    private fun owner(call: PluginCall): String {
        val value = call.getString("owner")
        require(value != null && UUID.fromString(value).toString().equals(value, ignoreCase = true)) {
            "Invalid owner"
        }
        return value
    }

    private fun receiptKey(call: PluginCall): String {
        val value = call.getString("key")
        require(value != null && RECEIPT_KEY.matches(value)) { "Invalid receipt key" }
        return value
    }

    private fun receiptValue(call: PluginCall, field: String): String {
        val value = call.getString(field)
        require(value != null && value.toByteArray(Charsets.UTF_8).size <= 512_000) {
            "Invalid receipt value"
        }
        return value
    }

    @PluginMethod
    fun list(call: PluginCall) {
        perform(call) { database ->
            val owner = owner(call)
            val rows = JSArray()
            database.query(
                "receipts", arrayOf("receipt_key", "value"), "owner=?", arrayOf(owner),
                null, null, "created_at,receipt_key",
            ).use { cursor ->
                while (cursor.moveToNext()) {
                    check(rows.length() < 64) { "Storage limit" }
                    rows.put(JSObject().apply {
                        put("key", cursor.getString(0))
                        put("value", cursor.getString(1))
                    })
                }
            }
            JSObject().apply { put("records", rows) }
        }
    }

    @PluginMethod
    fun put(call: PluginCall) {
        perform(call) { database ->
            val owner = owner(call)
            val key = receiptKey(call)
            val value = receiptValue(call, "value")
            database.beginTransaction()
            try {
                val previous = database.query(
                    "receipts", arrayOf("value"), "owner=? AND receipt_key=?", arrayOf(owner, key),
                    null, null, null,
                ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
                if (previous != null) {
                    check(previous == value) { "Receipt content changed" }
                } else {
                    check(DatabaseUtils.queryNumEntries(database, "receipts") < 64) { "Storage limit" }
                    val row = ContentValues().apply {
                        put("owner", owner)
                        put("receipt_key", key)
                        put("value", value)
                        put("created_at", System.currentTimeMillis())
                    }
                    database.insertOrThrow("receipts", null, row)
                }
                database.setTransactionSuccessful()
            } finally {
                database.endTransaction()
            }
            JSObject()
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        perform(call) { database ->
            database.delete(
                "receipts", "owner=? AND receipt_key=? AND value=?",
                arrayOf(owner(call), receiptKey(call), receiptValue(call, "expectedValue")),
            )
            JSObject()
        }
    }

    @PluginMethod
    fun listJournals(call: PluginCall) {
        perform(call) { database ->
            val owner = owner(call)
            val rows = JSArray()
            var bytes = 0L
            database.query(
                "journals", arrayOf("journal_key", "value"), "owner=?", arrayOf(owner),
                null, null, "journal_key",
            ).use { cursor ->
                while (cursor.moveToNext()) {
                    val value = cursor.getString(1)
                    val length = value.toByteArray(Charsets.UTF_8).size
                    bytes += length
                    check(rows.length() < 256 && length <= 6_000_000 && bytes <= 32_000_000) {
                        "Storage limit"
                    }
                    rows.put(JSObject().apply {
                        put("key", cursor.getString(0))
                        put("value", value)
                    })
                }
            }
            JSObject().apply { put("records", rows) }
        }
    }

    @PluginMethod
    fun writeJournal(call: PluginCall) {
        perform(call) { database ->
            val owner = owner(call)
            val key = call.getString("key")
            val data = call.data
            require(key != null && key.length <= 768 && JOURNAL_KEY.matches(key)
                && data.has("expectedValue") && data.has("value")) { "Invalid journal key" }
            require((data.isNull("expectedValue") || data.opt("expectedValue") is String)
                && (data.isNull("value") || data.opt("value") is String)) {
                "Invalid journal value type"
            }
            val expected = call.getString("expectedValue")
            val value = call.getString("value")
            require((expected == null || expected.toByteArray(Charsets.UTF_8).size <= 6_000_000)
                && (value == null || value.toByteArray(Charsets.UTF_8).size <= 6_000_000)) {
                "Invalid journal value"
            }
            database.beginTransaction()
            try {
                val previous = database.query(
                    "journals", arrayOf("value"), "owner=? AND journal_key=?", arrayOf(owner, key),
                    null, null, null,
                ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
                check(previous == expected) { "Journal changed" }
                if (value == null) {
                    database.delete("journals", "owner=? AND journal_key=?", arrayOf(owner, key))
                } else {
                    val count = DatabaseUtils.queryNumEntries(database, "journals")
                    var bytes = DatabaseUtils.longForQuery(
                        database, "SELECT COALESCE(sum(length(CAST(value AS BLOB))),0) FROM journals", null,
                    )
                    bytes += value.toByteArray(Charsets.UTF_8).size - (previous?.toByteArray(Charsets.UTF_8)?.size ?: 0)
                    check((previous != null || count < 256) && bytes <= 32_000_000) { "Storage limit" }
                    val row = ContentValues().apply {
                        put("owner", owner)
                        put("journal_key", key)
                        put("value", value)
                        put("updated_at", System.currentTimeMillis())
                    }
                    check(database.insertWithOnConflict("journals", null, row, SQLiteDatabase.CONFLICT_REPLACE) != -1L) {
                        "Write failed"
                    }
                }
                database.setTransactionSuccessful()
            } finally {
                database.endTransaction()
            }
            JSObject()
        }
    }

    private companion object {
        val RECEIPT_KEY = Regex("^[0-9]{1,16}:[0-9a-fA-F-]{36}$")
        val JOURNAL_KEY = Regex("^[A-Za-z0-9:._-]+$")
    }
}
