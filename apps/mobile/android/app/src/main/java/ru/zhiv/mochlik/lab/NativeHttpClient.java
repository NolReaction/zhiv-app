package ru.zhiv.mochlik.lab;

import com.getcapacitor.JSObject;
import android.text.TextUtils;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.Call;
import okhttp3.CookieJar;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.ResponseBody;

final class NativeHttpClient {
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).callTimeout(30, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).writeTimeout(15, TimeUnit.SECONDS).build();
    static final class Cancelled extends Exception {}
    static final class TooLarge extends Exception {}
    static final class Transfer {
        final AtomicBoolean cancelled = new AtomicBoolean(false);
        volatile Call call;
        void cancel() { cancelled.set(true); Call active = call; if (active != null) active.cancel(); }
    }
    static final class Response {
        final int status;
        final JSObject headers;
        final byte[] body;
        Response(int status, JSObject headers, byte[] body) { this.status = status; this.headers = headers; this.body = body; }
    }

    static Response execute(URI uri, String method, Map<String, String> headers, byte[] body, String token, Transfer transfer) throws Exception {
        if (transfer.cancelled.get()) throw new Cancelled();
        boolean permitsBody = !method.equals("GET") && !method.equals("HEAD");
        RequestBody payload = permitsBody ? RequestBody.create(body == null ? new byte[0] : body, (MediaType) null) : null;
        Request.Builder builder = new Request.Builder().url(uri.toString()).method(method, payload)
            .header("User-Agent", "MochlikMobile/Android").header("Cache-Control", "no-store");
        for (Map.Entry<String, String> header : headers.entrySet()) builder.header(header.getKey(), header.getValue());
        if (token != null) builder.header("Authorization", "Bearer " + token);
        Call call = CLIENT.newCall(builder.build());
        transfer.call = call;
        try {
            if (transfer.cancelled.get()) { call.cancel(); throw new Cancelled(); }
            try (okhttp3.Response response = call.execute()) {
                int status = response.code();
                if (status >= 300 && status < 400 && status != 304) throw new IllegalStateException("Redirect refused");
                JSObject responseHeaders = new JSObject();
                for (String name : response.headers().names()) {
                    if (NativeHttpPolicy.allowedResponseHeader(name)) {
                        String value = TextUtils.join(", ", response.headers(name));
                        if (value.length() <= 16384) responseHeaders.put(name, value);
                    }
                }
                ResponseBody responseBody = response.body();
                if (responseBody != null && responseBody.contentLength() > NativeHttpPolicy.MAX_RESPONSE_BYTES) throw new TooLarge();
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                if (responseBody != null) try (InputStream stream = responseBody.byteStream()) {
                    byte[] chunk = new byte[8192];
                    int count;
                    while ((count = stream.read(chunk)) != -1) {
                        if (transfer.cancelled.get()) throw new Cancelled();
                        if (output.size() + count > NativeHttpPolicy.MAX_RESPONSE_BYTES) throw new TooLarge();
                        output.write(chunk, 0, count);
                    }
                }
                if (transfer.cancelled.get()) throw new Cancelled();
                return new Response(status, responseHeaders, output.toByteArray());
            }
        } finally { transfer.call = null; }
    }
}
