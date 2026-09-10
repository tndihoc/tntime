import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  Clock3,
  Plus,
  Trash2,
  Sparkles,
  LayoutGrid,
  CalendarClock,
  X,
  AlertTriangle,
  GripVertical,
  ListChecks,
  PenSquare,
  CheckCircle2,
  Inbox,
  StickyNote,
} from "lucide-react";

/* ---------------------------------------------------------------------- */
/*  Design tokens                                                         */
/* ---------------------------------------------------------------------- */

const T = {
  bg: "#FCE9F1",
  surface: "#FFFFFF",
  surfaceMuted: "#FDF2F7",
  border: "#F6D8E4",
  borderStrong: "#EFB9D2",
  ink: "#2E2430",
  inkSoft: "#8C7488",
  inkFaint: "#C2A6B8",
  primary: "#D6487A",
  primaryDark: "#B22F5F",
  primarySoft: "#F7E0EA",
  accent: "#F2A93B",
  accentDark: "#C97F1D",
  accentSoft: "#FDEEDB",
  danger: "#C1495F",
  dangerSoft: "#FBEAEE",
  busy: "#FF3B7C",
};

/* ---------------------------------------------------------------------- */
/*  Constants & time model — 5-minute resolution                          */
/* ---------------------------------------------------------------------- */

const DAYS = [
  { short: "T2", full: "Thứ 2" },
  { short: "T3", full: "Thứ 3" },
  { short: "T4", full: "Thứ 4" },
  { short: "T5", full: "Thứ 5" },
  { short: "T6", full: "Thứ 6" },
  { short: "T7", full: "Thứ 7" },
  { short: "CN", full: "Chủ nhật" },
];

const HOUR_START = 6; // 06:00
const HOUR_END = 22; // day ends at 23:00 (last hour block is 22:00-23:00)
const SLOT_MIN = 5;
const DAY_START_MIN = HOUR_START * 60; // 360
const DAY_END_MIN = (HOUR_END + 1) * 60; // 1380
const DAY_RANGE_MIN = DAY_END_MIN - DAY_START_MIN; // 1020

const SLOTS = (() => {
  const arr = [];
  for (let m = DAY_START_MIN; m < DAY_END_MIN; m += SLOT_MIN) arr.push(m);
  return arr; // 204 slots of 5 minutes, e.g. 360, 365, ... 1375
})();

const DEADLINE_HOURS = Array.from({ length: HOUR_END - HOUR_START + 1 }, (_, i) => HOUR_START + 1 + i); // 7..23
const MINUTE_OPTIONS = Array.from({ length: 12 }, (_, i) => i * 5); // 0,5,...,55
const DURATION_HOUR_OPTIONS = [0, 1, 2, 3, 4, 5, 6];

function fmtTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}:00` : `${h}:${String(m).padStart(2, "0")}`;
}

function fmtDuration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}h${String(m).padStart(2, "0")}`;
  if (h) return `${h}h`;
  return `${m} phút`;
}

const CATEGORIES = [
  { id: "hoc", label: "Học trên lớp", bg: "#E2F5EE", border: "#1E9C7C", text: "#136952" },
  { id: "btvn", label: "Bài tập", bg: "#FDF0DC", border: "#E29A2E", text: "#8C5A12" },
  { id: "on", label: "Ôn thi", bg: "#F1E9FA", border: "#9370C9", text: "#5B3E8C" },
  { id: "clb", label: "CLB / Ngoại khoá", bg: "#FBE7DE", border: "#DB6B4F", text: "#963F29" },
  { id: "khac", label: "Việc khác", bg: "#EAF0E1", border: "#7C9459", text: "#4B5E38" },
];
const catOf = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];

const key = (day, min) => `${day}-${min}`;

const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------------------------------------------------------------------- */
/*  Local persistence — saves quietly to this browser, no login needed    */
/* ---------------------------------------------------------------------- */

const STORAGE_KEYS = {
  tasks: "tntime.tasks",
  busyBlocks: "tntime.busyBlocks",
};

function loadFromStorage(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}

function saveToStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* storage full or unavailable — fail silently, app still works in-session */
  }
}

/* ---------------------------------------------------------------------- */
/*  Fun feedback: a cheerful little chime for successful scheduling       */
/* ---------------------------------------------------------------------- */

function playSuccessChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const notes = [880, 1174.66, 1567.98]; // A5 - D6 - G6, a bright little "ta-da"
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const start = now + i * 0.085;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.16, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.32);
    });
    setTimeout(() => ctx.close(), 600);
  } catch (e) {
    /* no audio support — fail silently */
  }
}

/* ---------------------------------------------------------------------- */
/*  Scheduling helpers — busyBlocks + scheduled tasks are the single      */
/*  source of truth for what's occupied. There is no separate "free      */
/*  slots" layer anymore: anything not covered by a busy block or a      */
/*  scheduled task counts as free.                                       */
/* ---------------------------------------------------------------------- */

function buildAllOccupied(tasks, busyBlocks, excludeId) {
  const occ = {};
  busyBlocks.forEach((b) => {
    for (let m = b.startMin; m < b.startMin + b.durationMin; m += SLOT_MIN) {
      occ[key(b.day, m)] = "busy";
    }
  });
  tasks.forEach((t) => {
    if (t.status === "scheduled" && t.id !== excludeId) {
      for (let m = t.scheduledStartMin; m < t.scheduledStartMin + t.durationMin; m += SLOT_MIN) {
        occ[key(t.scheduledDay, m)] = t.id;
      }
    }
  });
  return occ;
}

function canPlace(occupied, day, startMin, durationMin, excludeId) {
  if (startMin + durationMin > DAY_END_MIN) return false;
  for (let m = startMin; m < startMin + durationMin; m += SLOT_MIN) {
    const v = occupied[key(day, m)];
    if (v && v !== excludeId) return false;
  }
  return true;
}

function autoSchedule(tasks, busyBlocks) {
  const occupied = buildAllOccupied(tasks, busyBlocks, null);
  const pending = tasks
    .filter((t) => t.status !== "scheduled")
    .slice()
    .sort((a, b) => {
      const da = a.deadlineDay * 10000 + a.deadlineMin;
      const db = b.deadlineDay * 10000 + b.deadlineMin;
      if (da !== db) return da - db;
      return b.durationMin - a.durationMin;
    });

  const results = {};
  pending.forEach((t) => {
    let placed = false;
    for (let day = 0; day <= t.deadlineDay && !placed; day++) {
      const upperBound =
        day === t.deadlineDay
          ? Math.min(DAY_END_MIN - t.durationMin, t.deadlineMin - t.durationMin)
          : DAY_END_MIN - t.durationMin;
      for (let m = DAY_START_MIN; m <= upperBound; m += SLOT_MIN) {
        if (canPlace(occupied, day, m, t.durationMin, null)) {
          for (let s = m; s < m + t.durationMin; s += SLOT_MIN) occupied[key(day, s)] = t.id;
          results[t.id] = { scheduledDay: day, scheduledStartMin: m, status: "scheduled" };
          placed = true;
          break;
        }
      }
    }
    if (!placed) results[t.id] = { scheduledDay: null, scheduledStartMin: null, status: "unscheduled" };
  });
  return results;
}

/* ---------------------------------------------------------------------- */
/*  Small UI atoms                                                        */
/* ---------------------------------------------------------------------- */

function StatCard({ icon: Icon, label, value, sub, accent, delay = 0 }) {
  return (
    <div
      className="tn-stat-card flex items-center gap-3.5 rounded-xl p-4"
      style={{
        backgroundColor: T.surface,
        boxShadow: "0 1px 2px rgba(50,40,20,0.05), 0 1px 0 rgba(50,40,20,0.03)",
        animationDelay: `${delay}ms`,
      }}
    >
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: accent + "17", color: accent }}
      >
        <Icon size={17} strokeWidth={2} />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[12px]" style={{ color: T.inkSoft }}>
          {label}
        </p>
        <p
          className="text-[22px] font-medium leading-tight"
          style={{ color: T.ink, fontFamily: "'Fraunces', Georgia, serif", fontVariantNumeric: "tabular-nums" }}
        >
          {value}
        </p>
        {sub && (
          <p className="truncate text-[11px]" style={{ color: T.inkFaint }}>
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  const isError = toast.type === "error";
  return (
    <div
      key={toast.id}
      className="tn-toast fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-full px-4 py-2.5 text-[13px] shadow-lg"
      style={{
        backgroundColor: isError ? "#3B2229" : "#1B2A25",
        color: "#FBF8F0",
      }}
    >
      {isError ? <AlertTriangle size={15} style={{ color: "#E7A0AE" }} /> : <CheckCircle2 size={15} style={{ color: "#7FCBB4" }} />}
      <span>{toast.message}</span>
      <button onClick={onClose} className="tn-icon-btn-dark ml-1 rounded-full p-0.5">
        <X size={13} />
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  Week grid — 5-minute rows. Shows busy blocks (#FF3B7C) as the base    */
/*  background, task blocks drawn on top. Used on the Dashboard only.     */
/* ---------------------------------------------------------------------- */

function WeekGrid({ busyBlocks, tasks, onDropTask, selectedTaskId, onSelectTask, celebrateIds = {} }) {
  const slotH = 7;
  const labelW = 54;
  const [dragOverKey, setDragOverKey] = useState(null);

  const busyKeys = useMemo(() => {
    const set = {};
    busyBlocks.forEach((b) => {
      for (let m = b.startMin; m < b.startMin + b.durationMin; m += SLOT_MIN) {
        set[key(b.day, m)] = true;
      }
    });
    return set;
  }, [busyBlocks]);

  return (
    <div className="overflow-x-auto">
      <div
        className="grid select-none"
        style={{
          gridTemplateColumns: `${labelW}px repeat(7, minmax(64px, 1fr))`,
          gridTemplateRows: `28px repeat(${SLOTS.length}, ${slotH}px)`,
          minWidth: 640,
        }}
      >
        {/* corner */}
        <div style={{ gridColumn: 1, gridRow: 1 }} />
        {DAYS.map((d, di) => (
          <div
            key={d.short}
            className="flex items-end justify-center pb-1 text-[12px] font-medium"
            style={{ gridColumn: di + 2, gridRow: 1, color: T.inkSoft }}
          >
            {d.short}
          </div>
        ))}

        {SLOTS.map((m, si) =>
          m % 60 === 0 ? (
            <div
              key={"lbl-" + m}
              className="flex items-start justify-end pr-2 text-[11px]"
              style={{
                gridColumn: 1,
                gridRow: si + 2,
                color: T.inkFaint,
                transform: "translateY(-6px)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {fmtTime(m)}
            </div>
          ) : null
        )}

        {/* base cells — one per 5-minute slot */}
        {DAYS.map((d, di) =>
          SLOTS.map((m, si) => {
            const k = key(di, m);
            const isBusy = !!busyKeys[k];
            const isOver = dragOverKey === k;
            const isHour = m % 60 === 0;
            const isHalf = m % 30 === 0;
            return (
              <div
                key={k}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverKey(k);
                }}
                onDragLeave={() => setDragOverKey((prev) => (prev === k ? null : prev))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverKey(null);
                  onDropTask(di, m);
                }}
                style={{
                  gridColumn: di + 2,
                  gridRow: si + 2,
                  backgroundColor: isBusy ? T.busy : T.primarySoft,
                  borderTop: isHour ? `1px solid ${T.borderStrong}` : isHalf ? `1px solid ${T.border}` : "1px solid transparent",
                  borderLeft: di === 0 ? "1px solid " + T.border : "1px solid rgba(255,255,255,0.35)",
                  borderRight: "1px solid rgba(255,255,255,0.35)",
                  outline: isOver ? `2px dashed ${T.primaryDark}` : "none",
                  outlineOffset: "-2px",
                }}
              />
            );
          })
        )}

        {/* task blocks */}
        {tasks
          .filter((t) => t.status === "scheduled")
          .map((t) => {
            const c = catOf(t.category);
            const selected = selectedTaskId === t.id;
            const celebrating = !!celebrateIds[t.id];
            const rowStart = (t.scheduledStartMin - DAY_START_MIN) / SLOT_MIN + 2;
            const rowSpan = t.durationMin / SLOT_MIN;
            return (
              <div
                key={t.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", t.id);
                }}
                onClick={() => onSelectTask(t.id)}
                title={`${t.name} · ${fmtDuration(t.durationMin)}`}
                className={`tn-task-block relative z-10 mx-0.5 my-0.5 cursor-grab rounded-lg border active:cursor-grabbing ${
                  celebrating ? "tn-celebrate" : ""
                }`}
                style={{
                  gridColumn: t.scheduledDay + 2,
                  gridRow: `${rowStart} / span ${rowSpan}`,
                  backgroundColor: c.bg,
                  borderColor: selected ? c.text : c.border,
                  borderWidth: selected ? 2 : 1,
                  color: c.text,
                  boxShadow: selected ? `0 0 0 3px ${c.bg}, 0 2px 6px rgba(30,20,10,0.12)` : "0 1px 2px rgba(30,20,10,0.05)",
                }}
              >
                <div className="flex h-full items-center gap-1 overflow-hidden px-1.5 text-[11px] font-medium leading-tight">
                  <GripVertical size={11} className="shrink-0 opacity-50" />
                  <span className="truncate">{t.name}</span>
                </div>
                {celebrating && <span className="tn-sparkle">✨</span>}
              </div>
            );
          })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  View: Dashboard — fully derived from busyBlocks + scheduled tasks     */
/* ---------------------------------------------------------------------- */

function DashboardView({ busyBlocks, tasks, onDropTask, celebrateIds }) {
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null;

  const scheduled = tasks.filter((t) => t.status === "scheduled");
  const scheduledMin = scheduled.reduce((s, t) => s + t.durationMin, 0);
  const totalBusyMin = busyBlocks.reduce((s, b) => s + b.durationMin, 0);
  const unscheduledCount = tasks.filter((t) => t.status === "unscheduled").length;

  const totalRangeMin = 7 * DAY_RANGE_MIN;
  const availableMin = Math.max(0, totalRangeMin - totalBusyMin);
  const totalFreeMin = Math.max(0, availableMin - scheduledMin);
  const utilization = availableMin ? Math.round((scheduledMin / availableMin) * 100) : 0;

  const perDay = DAYS.map((d, di) => {
    const busyMin = busyBlocks.filter((b) => b.day === di).reduce((s, b) => s + b.durationMin, 0);
    const dayScheduledMin = scheduled.filter((t) => t.scheduledDay === di).reduce((s, t) => s + t.durationMin, 0);
    const freeMin = Math.max(0, DAY_RANGE_MIN - busyMin - dayScheduledMin);
    return { ...d, busyMin, scheduledMin: dayScheduledMin, freeMin };
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={Clock3} label="Giờ rảnh / tuần" value={fmtDuration(totalFreeMin)} accent={T.primary} delay={0} />
        <StatCard
          icon={CalendarClock}
          label="Đã sắp xếp"
          value={fmtDuration(scheduledMin)}
          sub={`${scheduled.length} việc`}
          accent={T.accent}
          delay={60}
        />
        <StatCard icon={LayoutGrid} label="Tỷ lệ sử dụng" value={`${utilization}%`} accent="#9370C9" delay={120} />
        <StatCard
          icon={AlertTriangle}
          label="Chưa sắp xếp được"
          value={unscheduledCount}
          sub={unscheduledCount ? "cần điều chỉnh" : "ổn"}
          accent={T.danger}
          delay={180}
        />
      </div>

      <div className="tn-card rounded-xl p-4">
        <p className="mb-3 text-[13px] font-medium" style={{ color: T.ink }}>
          Bận cố định, đã sắp lịch &amp; rảnh theo ngày
        </p>
        <div className="space-y-2.5">
          {perDay.map((d) => (
            <div key={d.short} className="flex items-center gap-3">
              <span className="w-9 text-[12px]" style={{ color: T.inkSoft }}>
                {d.short}
              </span>
              <div className="relative h-4 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: T.primarySoft }}>
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-all duration-300"
                  style={{ width: `${(d.busyMin / DAY_RANGE_MIN) * 100}%`, backgroundColor: T.busy }}
                />
                <div
                  className="absolute inset-y-0 transition-all duration-300"
                  style={{
                    left: `${(d.busyMin / DAY_RANGE_MIN) * 100}%`,
                    width: `${(d.scheduledMin / DAY_RANGE_MIN) * 100}%`,
                    backgroundColor: T.accent,
                  }}
                />
              </div>
              <span className="w-28 text-right text-[11px]" style={{ color: T.inkFaint, fontVariantNumeric: "tabular-nums" }}>
                {fmtDuration(d.freeMin)} rảnh
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3.5 flex items-center gap-4 text-[11px]" style={{ color: T.inkSoft }}>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: T.busy }} /> Bận cố định
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: T.accent }} /> Đã sắp lịch
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: T.primarySoft, border: `1px solid ${T.borderStrong}` }} /> Rảnh
          </span>
        </div>
      </div>

      <div className="tn-card rounded-xl p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-medium" style={{ color: T.ink }}>
            Lịch tuần — kéo khối việc để đổi giờ, chính xác tới 5 phút
          </p>
          {selectedTask && (
            <span className="text-[12px]" style={{ color: T.inkSoft }}>
              Đang chọn: <b style={{ color: catOf(selectedTask.category).text }}>{selectedTask.name}</b>
            </span>
          )}
        </div>
        <WeekGrid
          busyBlocks={busyBlocks}
          tasks={tasks}
          onDropTask={(day, startMin) => onDropTask(selectedTaskId, day, startMin)}
          selectedTaskId={selectedTaskId}
          onSelectTask={setSelectedTaskId}
          celebrateIds={celebrateIds}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  Note modal — used by the busy-schedule notes editor                   */
/* ---------------------------------------------------------------------- */

function NoteModal({ data, onSave, onDelete, onClose }) {
  const [text, setText] = useState(data.note || "");
  return (
    <div className="tn-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="tn-modal w-full max-w-sm rounded-xl p-5"
        onClick={(e) => e.stopPropagation()}
        style={{ backgroundColor: T.surface }}
      >
        <p className="text-[13px] font-medium" style={{ color: T.ink }}>
          {DAYS[data.day].full} · {fmtTime(data.startMin)} – {fmtTime(data.startMin + data.durationMin)}
        </p>
        <p className="mt-0.5 text-[12px]" style={{ color: T.inkSoft }}>
          Bạn bận gì vào khung giờ này?
        </p>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="VD: Dạy lớp HSK3 tại trung tâm, đón con, đi làm thêm..."
          rows={3}
          className="tn-input mt-3 w-full resize-none rounded-md border px-3 py-2 text-[13px] outline-none"
          style={{ borderColor: T.border, color: T.ink, backgroundColor: T.surface }}
        />
        <div className="mt-4 flex items-center justify-between gap-2">
          {data.id ? (
            <button
              onClick={() => onDelete(data.id)}
              className="tn-icon-btn flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] font-medium"
              style={{ color: T.danger }}
            >
              <Trash2 size={13} /> Xoá
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button onClick={onClose} className="tn-btn-ghost rounded-md px-3 py-1.5 text-[12px] font-medium">
              Huỷ
            </button>
            <button onClick={() => onSave(text)} className="tn-btn-primary rounded-md px-3 py-1.5 text-[12px] font-medium text-white">
              Lưu
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  View: Busy schedule notes — this is now the ONLY place free/busy is   */
/*  defined. Drag to mark a block #FF3B7C, everything else stays pastel.  */
/* ---------------------------------------------------------------------- */

function BusyScheduleView({ busyBlocks, setBusyBlocks, notify }) {
  const dragRef = useRef(null); // { day, start, end } — minutes
  const [dragPreview, setDragPreview] = useState(null);
  const [modalData, setModalData] = useState(null); // null | { id?, day, startMin, durationMin, note }

  const busyKeys = useMemo(() => {
    const set = {};
    busyBlocks.forEach((b) => {
      for (let m = b.startMin; m < b.startMin + b.durationMin; m += SLOT_MIN) {
        set[key(b.day, m)] = true;
      }
    });
    return set;
  }, [busyBlocks]);

  useEffect(() => {
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDragPreview(null);
      if (d) {
        const start = Math.min(d.start, d.end);
        const end = Math.max(d.start, d.end);
        setModalData({ day: d.day, startMin: start, durationMin: end - start + SLOT_MIN, note: "" });
      }
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const handleCellDown = (day, min) => {
    dragRef.current = { day, start: min, end: min };
    setDragPreview({ day, start: min, end: min });
  };
  const handleCellEnter = (day, min) => {
    if (!dragRef.current || dragRef.current.day !== day) return;
    dragRef.current.end = min;
    setDragPreview({ ...dragRef.current });
  };

  const saveNote = (text) => {
    if (!modalData) return;
    const note = text.trim() || "Bận";
    if (modalData.id) {
      setBusyBlocks((prev) => prev.map((b) => (b.id === modalData.id ? { ...b, note } : b)));
      notify("Đã cập nhật ghi chú.", "success");
    } else {
      setBusyBlocks((prev) => [
        ...prev,
        { id: uid(), day: modalData.day, startMin: modalData.startMin, durationMin: modalData.durationMin, note },
      ]);
      notify("Đã ghi chú khung giờ bận — Tổng quan sẽ tự cập nhật.", "success");
    }
    setModalData(null);
  };
  const deleteNote = (id) => {
    setBusyBlocks((prev) => prev.filter((b) => b.id !== id));
    setModalData(null);
  };

  const slotH = 7;
  const labelW = 54;

  return (
    <div className="space-y-4">
      <div className="tn-card rounded-xl p-4">
        <p className="text-[13px] font-medium" style={{ color: T.ink }}>
          Lịch bận
        </p>
        <p className="mb-3 text-[12px]" style={{ color: T.inkSoft }}>
          Kéo chuột dọc theo một cột giờ để đánh dấu khung bận — chính xác tới 5 phút (VD 19:30–21:00), rồi ghi chú bạn bận việc gì.
          Khung giờ bận sẽ tô màu hồng đậm và tự động đồng bộ sang mục Tổng quan. Bấm vào khối đã ghi chú để sửa hoặc xoá.
        </p>
        <div className="overflow-x-auto">
          <div
            className="grid select-none"
            style={{
              gridTemplateColumns: `${labelW}px repeat(7, minmax(64px, 1fr))`,
              gridTemplateRows: `28px repeat(${SLOTS.length}, ${slotH}px)`,
              minWidth: 640,
            }}
          >
            <div style={{ gridColumn: 1, gridRow: 1 }} />
            {DAYS.map((d, di) => (
              <div
                key={d.short}
                className="flex items-end justify-center pb-1 text-[12px] font-medium"
                style={{ gridColumn: di + 2, gridRow: 1, color: T.inkSoft }}
              >
                {d.short}
              </div>
            ))}
            {SLOTS.map((m, si) =>
              m % 60 === 0 ? (
                <div
                  key={"lbl-" + m}
                  className="flex items-start justify-end pr-2 text-[11px]"
                  style={{
                    gridColumn: 1,
                    gridRow: si + 2,
                    color: T.inkFaint,
                    transform: "translateY(-6px)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {fmtTime(m)}
                </div>
              ) : null
            )}

            {DAYS.map((d, di) =>
              SLOTS.map((m, si) => {
                const inPreview =
                  dragPreview &&
                  dragPreview.day === di &&
                  m >= Math.min(dragPreview.start, dragPreview.end) &&
                  m <= Math.max(dragPreview.start, dragPreview.end);
                const isBusy = !!busyKeys[key(di, m)] || inPreview;
                const isHour = m % 60 === 0;
                const isHalf = m % 30 === 0;
                return (
                  <div
                    key={key(di, m)}
                    onMouseDown={() => handleCellDown(di, m)}
                    onMouseEnter={() => handleCellEnter(di, m)}
                    style={{
                      gridColumn: di + 2,
                      gridRow: si + 2,
                      backgroundColor: isBusy ? T.busy : T.primarySoft,
                      borderTop: isHour ? `1px solid ${T.borderStrong}` : isHalf ? `1px solid ${T.border}` : "1px solid transparent",
                      borderLeft: di === 0 ? "1px solid " + T.border : "1px solid rgba(255,255,255,0.35)",
                      borderRight: "1px solid rgba(255,255,255,0.35)",
                      cursor: "pointer",
                    }}
                  />
                );
              })
            )}

            {busyBlocks.map((b) => {
              const rowStart = (b.startMin - DAY_START_MIN) / SLOT_MIN + 2;
              const rowSpan = b.durationMin / SLOT_MIN;
              return (
                <div
                  key={b.id}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setModalData({ id: b.id, day: b.day, startMin: b.startMin, durationMin: b.durationMin, note: b.note })}
                  title={b.note}
                  className="tn-busy-block relative z-10 mx-0.5 my-0.5 flex cursor-pointer flex-col justify-center overflow-hidden rounded-lg border px-2 py-1"
                  style={{
                    gridColumn: b.day + 2,
                    gridRow: `${rowStart} / span ${rowSpan}`,
                    backgroundColor: "#FFE1EC",
                    borderColor: T.busy,
                    color: "#8A1240",
                  }}
                >
                  <span className="truncate text-[11px] font-medium leading-tight">{b.note}</span>
                  <span className="truncate text-[10px] opacity-70" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {fmtTime(b.startMin)}–{fmtTime(b.startMin + b.durationMin)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="mt-3.5 flex items-center gap-4 text-[11px]" style={{ color: T.inkSoft }}>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: T.primarySoft, border: `1px solid ${T.borderStrong}` }} /> Trống
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: T.busy }} /> Bận
          </span>
        </div>
      </div>

      {modalData && <NoteModal data={modalData} onSave={saveNote} onDelete={deleteNote} onClose={() => setModalData(null)} />}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  View: Assistant                                                       */
/* ---------------------------------------------------------------------- */

function AssistantView({ tasks, setTasks, busyBlocks, notify, celebrate }) {
  const [form, setForm] = useState({
    name: "",
    category: "hoc",
    durH: 1,
    durM: 0,
    deadlineDay: 4,
    deadlineH: 18,
    deadlineM: 0,
  });

  const addTask = () => {
    if (!form.name.trim()) {
      notify("Nhập tên việc cần làm trước đã nhé.", "error");
      return;
    }
    const durationMin = Number(form.durH) * 60 + Number(form.durM);
    const deadlineMin = Number(form.deadlineH) * 60 + Number(form.deadlineM);
    if (durationMin < SLOT_MIN) {
      notify("Chọn thời lượng ít nhất 5 phút.", "error");
      return;
    }
    if (deadlineMin - durationMin < DAY_START_MIN) {
      notify("Deadline quá sớm so với thời lượng, hãy chọn giờ muộn hơn.", "error");
      return;
    }
    setTasks((prev) => [
      ...prev,
      {
        id: uid(),
        name: form.name.trim(),
        category: form.category,
        durationMin,
        deadlineDay: Number(form.deadlineDay),
        deadlineMin,
        status: "pending",
        scheduledDay: null,
        scheduledStartMin: null,
      },
    ]);
    setForm((f) => ({ ...f, name: "" }));
  };

  const removeTask = (id) => setTasks((prev) => prev.filter((t) => t.id !== id));
  const unschedule = (id) =>
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status: "pending", scheduledDay: null, scheduledStartMin: null } : t))
    );

  const runAuto = () => {
    const results = autoSchedule(tasks, busyBlocks);
    const ids = Object.keys(results);
    if (!ids.length) {
      notify("Không có việc nào đang chờ sắp xếp.", "error");
      return;
    }
    setTasks((prev) => prev.map((t) => (results[t.id] ? { ...t, ...results[t.id] } : t)));
    const scheduledIds = ids.filter((id) => results[id].status === "scheduled");
    const okCount = scheduledIds.length;
    const failCount = ids.length - okCount;
    if (okCount) celebrate(scheduledIds);
    notify(
      failCount
        ? `Đã sắp xếp ${okCount} việc, còn ${failCount} việc chưa tìm được chỗ trống phù hợp.`
        : `Đã sắp xếp thành công ${okCount} việc vào thời gian rảnh.`,
      failCount ? "error" : "success"
    );
  };

  const pending = tasks.filter((t) => t.status !== "scheduled");
  const scheduled = tasks.filter((t) => t.status === "scheduled");

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
      {/* form */}
      <div className="tn-card h-fit space-y-3 rounded-xl p-4">
        <p className="flex items-center gap-2 text-[13px] font-medium" style={{ color: T.ink }}>
          <PenSquare size={15} style={{ color: T.primary }} /> Thêm việc cần làm
        </p>

        <div>
          <label className="mb-1 block text-[12px]" style={{ color: T.inkSoft }}>
            Tên lớp học / việc cần làm
          </label>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && addTask()}
            placeholder="VD: Ca dạy HSK3, Bài tập Toán..."
            className="tn-input w-full rounded-md border px-3 py-2 text-[13px] outline-none"
            style={{ borderColor: T.border, color: T.ink, backgroundColor: T.surface }}
          />
        </div>

        <div>
          <label className="mb-1 block text-[12px]" style={{ color: T.inkSoft }}>
            Phân loại
          </label>
          <select
            value={form.category}
            onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            className="tn-input w-full rounded-md border px-3 py-2 text-[13px] outline-none"
            style={{ borderColor: T.border, color: T.ink, backgroundColor: T.surface }}
          >
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-[12px]" style={{ color: T.inkSoft }}>
            Thời lượng — chính xác tới 5 phút
          </label>
          <div className="grid grid-cols-2 gap-3">
            <select
              value={form.durH}
              onChange={(e) => setForm((f) => ({ ...f, durH: e.target.value }))}
              className="tn-input w-full rounded-md border px-3 py-2 text-[13px] outline-none"
              style={{ borderColor: T.border, color: T.ink, backgroundColor: T.surface }}
            >
              {DURATION_HOUR_OPTIONS.map((h) => (
                <option key={h} value={h}>
                  {h} giờ
                </option>
              ))}
            </select>
            <select
              value={form.durM}
              onChange={(e) => setForm((f) => ({ ...f, durM: e.target.value }))}
              className="tn-input w-full rounded-md border px-3 py-2 text-[13px] outline-none"
              style={{ borderColor: T.border, color: T.ink, backgroundColor: T.surface }}
            >
              {MINUTE_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {String(m).padStart(2, "0")} phút
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-[12px]" style={{ color: T.inkSoft }}>
            Hạn chót — ngày
          </label>
          <select
            value={form.deadlineDay}
            onChange={(e) => setForm((f) => ({ ...f, deadlineDay: e.target.value }))}
            className="tn-input w-full rounded-md border px-3 py-2 text-[13px] outline-none"
            style={{ borderColor: T.border, color: T.ink, backgroundColor: T.surface }}
          >
            {DAYS.map((d, i) => (
              <option key={d.short} value={i}>
                {d.full}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-[12px]" style={{ color: T.inkSoft }}>
            Hạn chót — trước giờ
          </label>
          <div className="grid grid-cols-2 gap-3">
            <select
              value={form.deadlineH}
              onChange={(e) => setForm((f) => ({ ...f, deadlineH: e.target.value }))}
              className="tn-input w-full rounded-md border px-3 py-2 text-[13px] outline-none"
              style={{ borderColor: T.border, color: T.ink, backgroundColor: T.surface }}
            >
              {DEADLINE_HOURS.map((h) => (
                <option key={h} value={h}>
                  {h} giờ
                </option>
              ))}
            </select>
            <select
              value={form.deadlineM}
              onChange={(e) => setForm((f) => ({ ...f, deadlineM: e.target.value }))}
              className="tn-input w-full rounded-md border px-3 py-2 text-[13px] outline-none"
              style={{ borderColor: T.border, color: T.ink, backgroundColor: T.surface }}
            >
              {MINUTE_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {String(m).padStart(2, "0")} phút
                </option>
              ))}
            </select>
          </div>
        </div>

        <button onClick={addTask} className="tn-btn-primary flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-[13px] font-medium text-white">
          <Plus size={15} /> Thêm vào danh sách
        </button>
      </div>

      {/* lists */}
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-[13px] font-medium" style={{ color: T.ink }}>
            <ListChecks size={15} style={{ color: T.inkSoft }} /> Danh sách chờ sắp xếp ({pending.length})
          </p>
          <button onClick={runAuto} className="tn-btn-accent flex items-center gap-1.5 rounded-md px-4 py-2 text-[13px] font-medium text-white">
            <Sparkles size={15} /> Sắp xếp thông minh
          </button>
        </div>

        {pending.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center" style={{ borderColor: T.borderStrong }}>
            <Inbox size={22} style={{ color: T.inkFaint }} />
            <p className="text-[13px]" style={{ color: T.inkFaint }}>
              Chưa có việc nào đang chờ. Thêm việc ở form bên trái.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {pending.map((t) => {
              const c = catOf(t.category);
              return (
                <div
                  key={t.id}
                  className="tn-list-row flex items-center justify-between rounded-lg border px-3 py-2.5"
                  style={{
                    borderColor: t.status === "unscheduled" ? "#EDC3CB" : T.border,
                    backgroundColor: t.status === "unscheduled" ? T.dangerSoft : T.surface,
                  }}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.border }} />
                    <div>
                      <p className="text-[13px] font-medium" style={{ color: T.ink }}>
                        {t.name}
                      </p>
                      <p className="text-[11px]" style={{ color: T.inkFaint }}>
                        {c.label} · {fmtDuration(t.durationMin)} · hạn {DAYS[t.deadlineDay].full} {fmtTime(t.deadlineMin)}
                        {t.status === "unscheduled" && <span style={{ color: T.danger }}> · chưa tìm được chỗ trống</span>}
                      </p>
                    </div>
                  </div>
                  <button onClick={() => removeTask(t.id)} className="tn-icon-btn rounded-md p-1.5" style={{ color: T.inkFaint }}>
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <p className="pt-2 text-[13px] font-medium" style={{ color: T.ink }}>
          Đã sắp xếp ({scheduled.length})
        </p>
        {scheduled.length === 0 ? (
          <p className="text-[12px]" style={{ color: T.inkFaint }}>
            Chưa có việc nào được sắp lịch.
          </p>
        ) : (
          <div className="space-y-2">
            {scheduled.map((t) => {
              const c = catOf(t.category);
              return (
                <div key={t.id} className="tn-list-row flex items-center justify-between rounded-lg border px-3 py-2.5" style={{ borderColor: T.border, backgroundColor: T.surface }}>
                  <div className="flex items-center gap-2.5">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.border }} />
                    <div>
                      <p className="text-[13px] font-medium" style={{ color: T.ink }}>
                        {t.name}
                      </p>
                      <p className="text-[11px]" style={{ color: T.inkFaint }}>
                        {DAYS[t.scheduledDay].full} · {fmtTime(t.scheduledStartMin)} – {fmtTime(t.scheduledStartMin + t.durationMin)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => unschedule(t.id)} className="tn-icon-btn rounded-md px-2 py-1 text-[11px] font-medium" style={{ color: T.inkSoft }}>
                      Bỏ lịch
                    </button>
                    <button onClick={() => removeTask(t.id)} className="tn-icon-btn rounded-md p-1.5" style={{ color: T.inkFaint }}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  App shell                                                             */
/* ---------------------------------------------------------------------- */

const TABS = [
  { id: "dashboard", label: "Tổng quan", icon: LayoutGrid },
  { id: "busy", label: "Lịch bận & ghi chú", icon: StickyNote },
  { id: "assistant", label: "Trợ lý sắp xếp", icon: Sparkles },
];

export default function App() {
  const [view, setView] = useState("dashboard");
  const [tasks, setTasks] = useState(() => loadFromStorage(STORAGE_KEYS.tasks, []));
  const [busyBlocks, setBusyBlocks] = useState(() => loadFromStorage(STORAGE_KEYS.busyBlocks, []));
  const [toast, setToast] = useState(null);
  const [celebrateIds, setCelebrateIds] = useState({});

  const notify = useCallback((message, type = "success") => {
    setToast({ message, type, id: uid() });
  }, []);

  // Tự động lưu vào trình duyệt mỗi khi danh sách việc thay đổi
  useEffect(() => {
    saveToStorage(STORAGE_KEYS.tasks, tasks);
  }, [tasks]);

  // Tự động lưu vào trình duyệt mỗi khi lịch bận thay đổi
  useEffect(() => {
    saveToStorage(STORAGE_KEYS.busyBlocks, busyBlocks);
  }, [busyBlocks]);

  const celebrate = useCallback((ids) => {
    if (!ids || !ids.length) return;
    setCelebrateIds((prev) => {
      const next = { ...prev };
      ids.forEach((id) => (next[id] = true));
      return next;
    });
    playSuccessChime();
    setTimeout(() => {
      setCelebrateIds((prev) => {
        const next = { ...prev };
        ids.forEach((id) => delete next[id]);
        return next;
      });
    }, 900);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const handleDropTask = (taskId, day, startMin) => {
    if (!taskId) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const occupied = buildAllOccupied(tasks, busyBlocks, task.id);
    if (!canPlace(occupied, day, startMin, task.durationMin, task.id)) {
      notify("Không thể đặt vào đây — trùng khung giờ bận hoặc việc khác.", "error");
      return;
    }
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: "scheduled", scheduledDay: day, scheduledStartMin: startMin } : t))
    );
    celebrate([taskId]);
  };

  return (
    <div className="min-h-screen w-full" style={{ backgroundColor: T.bg, fontFamily: "'Outfit', system-ui, sans-serif", color: T.ink }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Outfit:wght@400;500;600;700&display=swap');

        ::selection { background-color: ${T.primary}33; color: ${T.ink}; }
        ::-webkit-scrollbar { height: 8px; width: 8px; }
        ::-webkit-scrollbar-thumb { background: ${T.borderStrong}; border-radius: 8px; }
        select, input { background-color: ${T.surface}; }

        .tn-card {
          background-color: ${T.surface};
          border: 1px solid ${T.border};
          box-shadow: 0 1px 2px rgba(50,40,20,0.04);
        }

        .tn-stat-card {
          opacity: 0;
          animation: tnRise 420ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        @keyframes tnRise {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .tn-btn-primary {
          background-color: ${T.primary};
          transition: background-color 150ms ease, transform 100ms ease;
        }
        .tn-btn-primary:hover { background-color: ${T.primaryDark}; }
        .tn-btn-primary:active { transform: scale(0.98); }

        .tn-btn-accent {
          background-color: ${T.accent};
          transition: background-color 150ms ease, transform 100ms ease;
        }
        .tn-btn-accent:hover { background-color: ${T.accentDark}; }
        .tn-btn-accent:active { transform: scale(0.98); }

        .tn-btn-ghost {
          color: ${T.inkSoft};
          border: 1px solid ${T.border};
          transition: background-color 150ms ease, border-color 150ms ease, transform 100ms ease;
        }
        .tn-btn-ghost:hover { background-color: ${T.surfaceMuted}; border-color: ${T.borderStrong}; }
        .tn-btn-ghost:active { transform: scale(0.98); }

        .tn-icon-btn { transition: background-color 150ms ease, color 150ms ease; }
        .tn-icon-btn:hover { background-color: ${T.surfaceMuted}; color: ${T.danger}; }

        .tn-icon-btn-dark { opacity: 0.7; transition: opacity 150ms ease, background-color 150ms ease; }
        .tn-icon-btn-dark:hover { opacity: 1; background-color: rgba(255,255,255,0.12); }

        .tn-list-row { transition: border-color 150ms ease, box-shadow 150ms ease; }
        .tn-list-row:hover { border-color: ${T.borderStrong}; box-shadow: 0 1px 3px rgba(50,40,20,0.06); }

        .tn-busy-block { transition: box-shadow 150ms ease, transform 100ms ease; }
        .tn-busy-block:hover { transform: translateY(-1px); box-shadow: 0 2px 6px rgba(69,60,96,0.16); }

        .tn-modal-overlay {
          background-color: rgba(46, 36, 48, 0.35);
          backdrop-filter: blur(2px);
          animation: tnFadeIn 150ms ease;
        }
        @keyframes tnFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .tn-modal {
          box-shadow: 0 16px 36px rgba(46,36,48,0.24);
          animation: tnModalIn 180ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        @keyframes tnModalIn {
          from { opacity: 0; transform: scale(0.96) translateY(6px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }

        .tn-task-block { transition: box-shadow 150ms ease, transform 100ms ease; }
        .tn-task-block:hover { transform: translateY(-1px); }

        .tn-celebrate { animation: tnBlinkGlow 900ms ease-in-out; }
        @keyframes tnBlinkGlow {
          0%, 100% { box-shadow: 0 0 0 0 rgba(214,72,122,0); }
          20% { box-shadow: 0 0 0 5px rgba(214,72,122,0.38); }
          40% { box-shadow: 0 0 0 0 rgba(214,72,122,0); }
          65% { box-shadow: 0 0 0 5px rgba(242,169,59,0.38); }
          85% { box-shadow: 0 0 0 0 rgba(214,72,122,0); }
        }
        .tn-sparkle {
          position: absolute;
          top: -9px;
          right: -7px;
          font-size: 15px;
          line-height: 1;
          pointer-events: none;
          animation: tnSparklePop 900ms ease-in-out;
        }
        @keyframes tnSparklePop {
          0% { opacity: 0; transform: scale(0.3) rotate(-15deg); }
          25% { opacity: 1; transform: scale(1.2) rotate(10deg); }
          55% { opacity: 1; transform: scale(0.9) rotate(-6deg); }
          100% { opacity: 0; transform: scale(0.6) rotate(0deg); }
        }

        .tn-input { transition: border-color 150ms ease, box-shadow 150ms ease; }
        .tn-input:focus { border-color: ${T.primary}; box-shadow: 0 0 0 3px ${T.primary}22; }

        .tn-nav-item { transition: background-color 150ms ease, color 150ms ease; }
        .tn-nav-item:hover:not(.tn-nav-item-active) { background-color: ${T.surfaceMuted}; color: ${T.ink}; }

        .tn-toast {
          animation: tnToastIn 260ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        @keyframes tnToastIn {
          from { opacity: 0; transform: translate(-50%, 8px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }

        button:focus-visible, input:focus-visible, select:focus-visible {
          outline: 2px solid ${T.primary};
          outline-offset: 2px;
        }
      `}</style>

      <header style={{ borderBottom: `1px solid ${T.border}` }}>
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1
              className="text-[26px] font-semibold leading-none"
              style={{ fontFamily: "'Fraunces', Georgia, serif", color: T.ink, letterSpacing: "-0.01em" }}
            >
              TNTime
            </h1>
            <p className="mt-1.5 text-[12px]" style={{ color: T.inkSoft }}>
              Tự động tối ưu thời gian trống trong tuần — chính xác tới từng 5 phút
            </p>
          </div>
          <nav className="flex flex-wrap gap-1 rounded-lg p-1" style={{ border: `1px solid ${T.border}`, backgroundColor: T.surface }}>
            {TABS.map((t) => {
              const active = view === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => setView(t.id)}
                  className={`tn-nav-item flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium ${active ? "tn-nav-item-active" : ""}`}
                  style={{
                    backgroundColor: active ? T.primary : "transparent",
                    color: active ? "#FFFFFF" : T.inkSoft,
                    boxShadow: active ? "0 1px 2px rgba(10,50,40,0.2)" : "none",
                  }}
                >
                  <Icon size={14} />
                  {t.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-6">
        {view === "dashboard" && (
          <DashboardView busyBlocks={busyBlocks} tasks={tasks} onDropTask={handleDropTask} celebrateIds={celebrateIds} />
        )}
        {view === "busy" && <BusyScheduleView busyBlocks={busyBlocks} setBusyBlocks={setBusyBlocks} notify={notify} />}
        {view === "assistant" && (
          <AssistantView tasks={tasks} setTasks={setTasks} busyBlocks={busyBlocks} notify={notify} celebrate={celebrate} />
        )}
      </main>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
