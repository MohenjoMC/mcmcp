package dev.mcmcp;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;

/**
 * The mod's on-disk configuration. The bridge reads the same files, so the two
 * processes agree on host, port and token without any handshake.
 */
public final class Config {
    public String host = "127.0.0.1";
    public int port = 25585;
    public String tokenFile = "";
    public boolean allowRemote = false;

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final SecureRandom RANDOM = new SecureRandom();

    public static Path configDir() {
        String xdg = System.getenv("XDG_CONFIG_HOME");
        Path base;
        if (xdg != null && !xdg.isBlank()) {
            base = Path.of(xdg);
        } else {
            base = Path.of(System.getProperty("user.home"), ".config");
        }
        return base.resolve("mcmcp");
    }

    public static Path clientsDir() {
        return configDir().resolve("clients");
    }

    public static Path defaultTokenFile() {
        return configDir().resolve("token");
    }

    public static Config load(Logger log) {
        Config config = new Config();
        Path file = FabricLoader.getInstance().getConfigDir().resolve("mcmcp.json");
        if (Files.isRegularFile(file)) {
            try {
                JsonObject json = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
                if (json.has("host")) config.host = json.get("host").getAsString();
                if (json.has("port")) config.port = json.get("port").getAsInt();
                if (json.has("tokenFile")) config.tokenFile = json.get("tokenFile").getAsString();
                if (json.has("allowRemote")) config.allowRemote = json.get("allowRemote").getAsBoolean();
            } catch (Exception e) {
                log.warn("[mcmcp] could not read {}: {}", file, e.toString());
            }
        } else {
            try {
                Files.createDirectories(file.getParent());
                JsonObject defaults = new JsonObject();
                defaults.addProperty("host", config.host);
                defaults.addProperty("port", config.port);
                defaults.addProperty("tokenFile", defaultTokenFile().toString());
                defaults.addProperty("allowRemote", false);
                Files.writeString(file, GSON.toJson(defaults), StandardCharsets.UTF_8);
            } catch (IOException e) {
                log.warn("[mcmcp] could not write {}", file, e);
            }
        }
        return config;
    }

    /** Token precedence: -Dmcmcp.token, MCMCP_TOKEN, config file, ~/.config/mcmcp/token. */
    public String resolveToken(Logger log) {
        String prop = System.getProperty("mcmcp.token");
        if (prop != null && !prop.isBlank()) return prop.trim();
        String env = System.getenv("MCMCP_TOKEN");
        if (env != null && !env.isBlank()) return env.trim();

        Path file = tokenFile == null || tokenFile.isBlank() ? defaultTokenFile() : Path.of(tokenFile.replace("~", System.getProperty("user.home")));
        try {
            if (Files.isRegularFile(file)) {
                String value = Files.readString(file, StandardCharsets.UTF_8).trim();
                if (!value.isEmpty()) return value;
            }
            Files.createDirectories(file.getParent());
            String token = randomToken();
            Files.writeString(file, token + System.lineSeparator(), StandardCharsets.UTF_8);
            try {
                Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
            } catch (UnsupportedOperationException ignored) {
                // non-POSIX filesystem
            }
            log.info("[mcmcp] generated a new control token at {}", file);
            return token;
        } catch (IOException e) {
            log.error("[mcmcp] cannot read or create the token file {}", file, e);
            return randomToken();
        }
    }

    public static String randomToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(64);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /** Written so the CLI can find this client without guessing ports. */
    public static void writeRuntime(int port, String mcVersion, String modVersion, String player, long startedAt, Logger log) {
        try {
            Path dir = clientsDir();
            Files.createDirectories(dir);
            JsonObject json = new JsonObject();
            json.addProperty("pid", ProcessHandle.current().pid());
            json.addProperty("port", port);
            json.addProperty("mcVersion", mcVersion);
            json.addProperty("modVersion", modVersion);
            json.addProperty("player", player);
            json.addProperty("startedAt", startedAt);
            json.addProperty("host", "127.0.0.1");
            Files.writeString(dir.resolve(ProcessHandle.current().pid() + ".json"), GSON.toJson(json), StandardCharsets.UTF_8);
        } catch (IOException e) {
            log.warn("[mcmcp] could not write the runtime descriptor", e);
        }
    }

    public static void removeRuntime() {
        try {
            Files.deleteIfExists(clientsDir().resolve(ProcessHandle.current().pid() + ".json"));
        } catch (IOException ignored) {
        }
    }
}
