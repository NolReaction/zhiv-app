package ru.zhiv.mochlik.lab;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Bounded atomic command receipts; credentials are stored separately in the session vault. */
@CapacitorPlugin(name = "MochlikStorage")
public final class MochlikStoragePlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private ReceiptDatabase helper;

    @Override public void load() { helper = new ReceiptDatabase(getContext()); }
    @Override protected void handleOnDestroy() {
        worker.execute(() -> { if (helper != null) helper.close(); });
        worker.shutdown();
        super.handleOnDestroy();
    }
    private static final class ReceiptDatabase extends SQLiteOpenHelper {
        ReceiptDatabase(Context context) {
            super(context, context.getNoBackupFilesDir().getAbsolutePath() + "/mochlik-receipts.sqlite", null, 1);
            setWriteAheadLoggingEnabled(true);
        }
        @Override public void onConfigure(SQLiteDatabase database) { database.execSQL("PRAGMA synchronous=FULL"); }
        @Override public void onCreate(SQLiteDatabase database) {
            database.execSQL("CREATE TABLE receipts(owner TEXT NOT NULL, receipt_key TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner, receipt_key))");
        }
        @Override public void onUpgrade(SQLiteDatabase database, int oldVersion, int newVersion) {
            throw new IllegalStateException("Unknown storage migration");
        }
    }
    private interface Operation { JSObject run(SQLiteDatabase database) throws Exception; }
    private void perform(PluginCall call, Operation operation) {
        worker.execute(() -> {
            try { call.resolve(operation.run(helper.getWritableDatabase())); }
            catch (Exception failure) { call.reject("Не удалось прочитать или сохранить очередь устройства", "STORAGE_FAILED"); }
        });
    }
    private static String owner(PluginCall call) {
        String value = call.getString("owner");
        if (value == null || !UUID.fromString(value).toString().equalsIgnoreCase(value)) throw new IllegalArgumentException("Invalid owner");
        return value;
    }
    private static String key(PluginCall call) {
        String value = call.getString("key");
        if (value == null || !value.matches("^[0-9]{1,16}:[0-9a-fA-F-]{36}$")) throw new IllegalArgumentException("Invalid receipt key");
        return value;
    }
    private static String value(PluginCall call, String field) {
        String value = call.getString(field);
        if (value == null || value.getBytes(StandardCharsets.UTF_8).length > 512000) throw new IllegalArgumentException("Invalid receipt value");
        return value;
    }
    @PluginMethod public void list(PluginCall call) {
        perform(call, database -> {
            String owner = owner(call);
            JSArray rows = new JSArray();
            try (Cursor cursor = database.query("receipts", new String[]{"receipt_key", "value"}, "owner=?", new String[]{owner}, null, null, "created_at,receipt_key")) {
                while (cursor.moveToNext()) {
                    if (rows.length() >= 64) throw new IllegalStateException("Storage limit");
                    rows.put(new JSObject().put("key", cursor.getString(0)).put("value", cursor.getString(1)));
                }
            }
            return new JSObject().put("records", rows);
        });
    }
    @PluginMethod public void put(PluginCall call) {
        perform(call, database -> {
            String owner = owner(call), key = key(call), value = value(call, "value");
            database.beginTransaction();
            try {
                String previous = null;
                try (Cursor cursor = database.query("receipts", new String[]{"value"}, "owner=? AND receipt_key=?", new String[]{owner, key}, null, null, null)) {
                    if (cursor.moveToFirst()) previous = cursor.getString(0);
                }
                if (previous != null) {
                    if (!previous.equals(value)) throw new IllegalStateException("Receipt content changed");
                } else {
                    if (DatabaseUtils.queryNumEntries(database, "receipts") >= 64) throw new IllegalStateException("Storage limit");
                    ContentValues row = new ContentValues();
                    row.put("owner", owner); row.put("receipt_key", key); row.put("value", value); row.put("created_at", System.currentTimeMillis());
                    database.insertOrThrow("receipts", null, row);
                }
                database.setTransactionSuccessful();
            } finally { database.endTransaction(); }
            return new JSObject();
        });
    }
    @PluginMethod public void remove(PluginCall call) {
        perform(call, database -> {
            database.delete("receipts", "owner=? AND receipt_key=? AND value=?", new String[]{owner(call), key(call), value(call, "expectedValue")});
            return new JSObject();
        });
    }
}
