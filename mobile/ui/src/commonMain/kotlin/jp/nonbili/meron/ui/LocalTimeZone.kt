package jp.nonbili.meron.ui

/**
 * Seconds the device's time zone is ahead of UTC at [epochSeconds], daylight
 * saving included. The calendar's date arithmetic takes this as its only
 * platform input (see CalendarAgenda.kt).
 */
internal expect fun localUtcOffsetSeconds(epochSeconds: Long): Int
