package dev.mcmcp;

import com.google.gson.JsonObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.PriorityQueue;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.function.IntFunction;

/**
 * Chat/screen/lifecycle events with polling support, plus the tick scheduler the
 * async methods (walk, moveTo, waitFor) are built on. Everything runs on the
 * client thread; only {@link #poll} blocks, and it blocks an HTTP thread.
 */
public final class Events {
    public static final int BUFFER_SIZE = 2000;

    public record Event(long seq, long time, String type, JsonObject data) {
        public JsonObject toJson() {
            JsonObject json = new JsonObject();
            json.addProperty("seq", seq);
            json.addProperty("time", time);
            json.addProperty("type", type);
            json.add("data", data);
            return json;
        }
    }

    private static final class Task {
        long dueTick;
        final IntFunction<Boolean> body;
        int runs;

        Task(long dueTick, IntFunction<Boolean> body) {
            this.dueTick = dueTick;
            this.body = body;
        }
    }

    private final ArrayDeque<Event> buffer = new ArrayDeque<>();
    private final Object lock = new Object();
    private final PriorityQueue<Task> tasks = new PriorityQueue<>(Comparator.comparingLong(t -> t.dueTick));
    private long seq = 0;
    private long tick = 0;
    private boolean tickEvents = false;

    public void add(String type, JsonObject data) {
        synchronized (lock) {
            Event event = new Event(++seq, System.currentTimeMillis(), type, data);
            buffer.addLast(event);
            while (buffer.size() > BUFFER_SIZE) buffer.removeFirst();
            lock.notifyAll();
        }
    }

    public long lastSeq() {
        synchronized (lock) {
            return seq;
        }
    }

    public boolean tickEvents() {
        return tickEvents;
    }

    public void setTickEvents(boolean value) {
        tickEvents = value;
    }

    /** Returns events after {@code after}. When {@code after < 0} the most recent 50 are returned. */
    public List<Event> since(long after, int limit) {
        List<Event> out = new ArrayList<>();
        synchronized (lock) {
            if (after < 0) {
                List<Event> all = new ArrayList<>(buffer);
                int from = Math.max(0, all.size() - Math.min(limit, 50));
                out.addAll(all.subList(from, all.size()));
                return out;
            }
            for (Event event : buffer) {
                if (event.seq() > after) {
                    out.add(event);
                    if (out.size() >= limit) break;
                }
            }
        }
        return out;
    }

    /** Long-poll: blocks this (HTTP) thread until an event arrives or the timeout expires. */
    public List<Event> poll(long after, long timeoutMs, Set<String> types) {
        long deadline = System.currentTimeMillis() + Math.max(0, timeoutMs);
        synchronized (lock) {
            while (true) {
                List<Event> matches = new ArrayList<>();
                for (Event event : buffer) {
                    if (event.seq() > after && (types == null || types.isEmpty() || types.contains(event.type()))) {
                        matches.add(event);
                        if (matches.size() >= 200) break;
                    }
                }
                if (!matches.isEmpty()) return matches;

                long wait = deadline - System.currentTimeMillis();
                if (wait <= 0) return List.of();
                try {
                    lock.wait(Math.min(wait, 250));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return List.of();
                }
            }
        }
    }

    public long currentTick() {
        return tick;
    }

    /** Called once per client tick on the client thread. */
    public void onTick() {
        tick++;
        List<Task> due = new ArrayList<>();
        synchronized (tasks) {
            while (!tasks.isEmpty() && tasks.peek().dueTick <= tick) due.add(tasks.poll());
        }
        for (Task task : due) {
            boolean keepGoing;
            try {
                keepGoing = Boolean.TRUE.equals(task.body.apply(task.runs++));
            } catch (Throwable t) {
                McmcpMod.LOGGER.warn("[mcmcp] scheduled task failed", t);
                keepGoing = false;
            }
            if (keepGoing) {
                task.dueTick = tick + 1;
                synchronized (tasks) {
                    tasks.add(task);
                }
            }
        }
        if (tickEvents) {
            JsonObject data = new JsonObject();
            data.addProperty("tick", tick);
            data.addProperty("time", System.currentTimeMillis());
            add("tick", data);
        }
    }

    /** Runs the action after {@code ticks} client ticks. */
    public CompletableFuture<Void> after(int ticks, Runnable action) {
        CompletableFuture<Void> future = new CompletableFuture<>();
        Task task = new Task(tick + Math.max(1, ticks), run -> {
            try {
                action.run();
                future.complete(null);
            } catch (Throwable t) {
                future.completeExceptionally(t);
            }
            return false;
        });
        synchronized (tasks) {
            tasks.add(task);
        }
        return future;
    }

    /**
     * Runs the predicate each tick for at most {@code ticks} ticks. The predicate
     * receives the zero-based tick index and returns true to keep going.
     */
    public CompletableFuture<Integer> tickFor(int ticks, java.util.function.IntPredicate action) {
        CompletableFuture<Integer> future = new CompletableFuture<>();
        Task task = new Task(tick, run -> {
            boolean more;
            try {
                more = action.test(run);
            } catch (Throwable t) {
                future.completeExceptionally(t);
                return false;
            }
            if (!more || run + 1 >= ticks) {
                future.complete(run);
                return false;
            }
            return true;
        });
        synchronized (tasks) {
            tasks.add(task);
        }
        return future;
    }

    /** Runs the predicate every tick until it returns true, or the budget runs out. */
    public CompletableFuture<Integer> tickUntil(int maxTicks, java.util.function.IntPredicate done) {
        return tickFor(maxTicks, run -> !done.test(run));
    }
}
