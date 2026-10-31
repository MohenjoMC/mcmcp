package dev.mcmcp;

import com.google.gson.JsonObject;

public class McmcpException extends RuntimeException {
    public final int code;
    public final JsonObject data;

    public McmcpException(int code, String message) {
        this(code, message, null);
    }

    public McmcpException(int code, String message, JsonObject data) {
        super(message);
        this.code = code;
        this.data = data;
    }
}
