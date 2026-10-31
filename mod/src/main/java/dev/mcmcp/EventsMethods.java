package dev.mcmcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Event polling and tick subscriptions. */
public final class EventsMethods {
    private EventsMethods() {
    }

    public static void register(Dispatcher d) {
        d.add("events.poll", "Long-poll for chat, screen, join/leave and death events.",
                "{\"events\":[{\"seq\",\"time\",\"type\",\"data\"}],\"next\"}",
                Dispatcher.params(
                        "after", Dispatcher.param("integer", false, "only events with seq > after; omit for the recent backlog"),
                        "timeoutMs", Dispatcher.param("integer", false, "default 5000, max 30000"),
                        "types", Dispatcher.param("array", false, "filter, e.g. [\"chat\",\"screen\"]")),
                params -> {
                    long after = Args.has(params, "after") ? Args.longValue(params, "after", -1) : -1;
                    int timeoutMs = Math.min(30_000, Math.max(0, Args.integer(params, "timeoutMs", 5000)));
                    Set<String> types = new HashSet<>();
                    JsonElement raw = params.get("types");
                    if (raw != null && raw.isJsonArray()) {
                        for (JsonElement element : raw.getAsJsonArray()) {
                            if (!element.isJsonNull()) types.add(element.getAsString().toLowerCase(java.util.Locale.ROOT));
                        }
                    } else if (raw != null && raw.isJsonPrimitive()) {
                        for (String type : raw.getAsString().split(",")) {
                            if (!type.isBlank()) types.add(type.trim().toLowerCase(java.util.Locale.ROOT));
                        }
                    }
                    List<Events.Event> found = McmcpMod.events().poll(after, timeoutMs, types);
                    JsonArray array = new JsonArray();
                    long next = after;
                    for (Events.Event event : found) {
                        array.add(event.toJson());
                        next = Math.max(next, event.seq());
                    }
                    if (next < 0) next = McmcpMod.events().lastSeq();
                    return Json.object("events", array, "next", next);
                });

        d.add("events.subscribe", "Turn per-tick events on or off.", "{\"tick\":bool}",
                Dispatcher.params("tick", Dispatcher.param("boolean", true, "true to emit a tick event every client tick")),
                params -> {
                    boolean tick = Args.bool(params, "tick", true);
                    McmcpMod.events().setTickEvents(tick);
                    return Json.object("tick", tick);
                });

        d.add("events.last", "The most recent event sequence number.", "{\"seq\":n}",
                Dispatcher.empty(), params -> Json.object("seq", McmcpMod.events().lastSeq()));
    }
}
