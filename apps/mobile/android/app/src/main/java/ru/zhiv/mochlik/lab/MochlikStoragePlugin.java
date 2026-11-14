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
            super(context, context.getNoBackupFilesDir().getAbsolutePath() + "/mochlik-receipts.sqlite", null, 2);
            setWriteAheadLoggingEnabled(true);
        }
        @Override public void onConfigure(SQLiteDatabase database) { database.execSQL("PRAGMA synchronous=FULL"); }
        @Override public void onCreate(SQLiteDatabase database) {
            database.execSQL("CREATE TABLE receipts(owner TEXT NOT NULL, receipt_key TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner, receipt_key))");
            createJournals(database);
        }
        private static void createJournals(SQLiteDatabase database) {
            database.execSQL("CREATE TABLE journals(owner TEXT NOT NULL, journal_key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner, journal_key))");
        }
        @Override public void onUpgrade(SQLiteDatabase database, int oldVersion, int newVersion) {
            if (oldVersion == 1 && newVersion == 2) createJournals(database);
            else throw new IllegalStateException("Unknown storage migration");
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
    @PluginMethod public void listJournals(PluginCall call) {
        perform(call, database -> {
            String owner = owner(call);
            JSArray rows = new JSArray();
            long bytes = 0;
            try (Cursor cursor = database.query("journals", new String[]{"journal_key", "value"}, "owner=?", new String[]{owner}, null, null, "journal_key")) {
                while (cursor.moveToNext()) {
                    String value = cursor.getString(1);
                    int length = value.getBytes(StandardCharsets.UTF_8).length;
                    bytes += length;
                    if (rows.length() >= 256 || length > 6000000 || bytes > 32000000) throw new IllegalStateException("Storage limit");
                    rows.put(new JSObject().put("key", cursor.getString(0)).put("value", value));
                }
            }
            return new JSObject().put("records", rows);
        });
    }
    @PluginMethod public void writeJournal(PluginCall call) {
        perform(call, database -> {
            String owner = owner(call), key = call.getString("key");
            if (key == null || key.length() > 768 || !key.matches("^[A-Za-z0-9:._-]+$")
                || !call.getData().has("expectedValue") || !call.getData().has("value")) throw new IllegalArgumentException("Invalid journal key");
            if (!(call.getData().isNull("expectedValue") || call.getData().opt("expectedValue") instanceof String)
                || !(call.getData().isNull("value") || call.getData().opt("value") instanceof String)) throw new IllegalArgumentException("Invalid journal value type");
            String expected = call.getString("expectedValue"), value = call.getString("value");
            if (expected != null && expected.getBytes(StandardCharsets.UTF_8).length > 6000000
                || value != null && value.getBytes(StandardCharsets.UTF_8).length > 6000000) throw new IllegalArgumentException("Invalid journal value");
            database.beginTransaction();
            try {
                String previous = null;
                try (Cursor cursor = database.query("journals", new String[]{"value"}, "owner=? AND journal_key=?", new String[]{owner, key}, null, null, null)) {
                    if (cursor.moveToFirst()) previous = cursor.getString(0);
                }
                if (!java.util.Objects.equals(previous, expected)) throw new IllegalStateException("Journal changed");
                if (value == null) database.delete("journals", "owner=? AND journal_key=?", new String[]{owner, key});
                else {
                    long count = DatabaseUtils.queryNumEntries(database, "journals");
                    long bytes = DatabaseUtils.longForQuery(database, "SELECT COALESCE(sum(length(CAST(value AS BLOB))),0) FROM journals", null);
                    bytes += value.getBytes(StandardCharsets.UTF_8).length - (previous == null ? 0 : previous.getBytes(StandardCharsets.UTF_8).length);
                    if (previous == null && count >= 256 || bytes > 32000000) throw new IllegalStateException("Storage limit");
                    ContentValues row = new ContentValues();
                    row.put("owner", owner); row.put("journal_key", key); row.put("value", value); row.put("updated_at", System.currentTimeMillis());
                    if (database.insertWithOnConflict("journals", null, row, SQLiteDatabase.CONFLICT_REPLACE) == -1) throw new IllegalStateException("Write failed");
                }
                database.setTransactionSuccessful();
            } finally { database.endTransaction(); }
            return new JSObject();
        });
    }

}
