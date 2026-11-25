"use client";

import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui";

// הגדרות הבאנר העליון — כאן בלבד. להסרה: ANNOUNCEMENT_ENABLED = false.
export const ANNOUNCEMENT_ENABLED = true;
export const ANNOUNCEMENT_TEXT = "האתר בהרצה. תודה על הסבלנות!";

export function AnnouncementBar() {
  const pathname = usePathname();

  // מוצג רק בעמודים המיועדים ללקוחות (לא בממשק הניהול).
  if (!ANNOUNCEMENT_ENABLED || pathname?.startsWith("/admin")) return null;

  return (
    <div
      role="status"
      className="w-full bg-bronze-50 border-b border-bronze-200/70 text-bronze-700"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 min-h-9 sm:min-h-10 py-1.5 flex items-center justify-center gap-2 text-center text-xs sm:text-sm font-medium">
        <Icon
          name="info"
          aria-hidden="true"
          className="w-4 h-4 shrink-0 text-bronze-500"
        />
        <span>{ANNOUNCEMENT_TEXT}</span>
      </div>
    </div>
  );
}
