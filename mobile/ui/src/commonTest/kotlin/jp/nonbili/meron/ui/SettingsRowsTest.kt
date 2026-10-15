package jp.nonbili.meron.ui

import kotlin.test.Test
import kotlin.test.assertEquals

class SettingsRowsTest {
    // Shaped like the account settings: rows above the network section that
    // only some accounts have, and one inside it.
    private fun accountLike(
        senderName: Boolean,
        serverRow: Boolean,
    ) = settingsRows {
        row { }
        row { }
        if (senderName) row { }
        row(SETTINGS_ROW_NETWORK) { }
        if (serverRow) row { }
        row { }
    }

    @Test
    fun theNetworkRowIsWhereTheRowsAboveItPutIt() {
        assertEquals(2, accountLike(senderName = false, serverRow = false).startIndex(SETTINGS_ROW_NETWORK))
        assertEquals(3, accountLike(senderName = true, serverRow = true).startIndex(SETTINGS_ROW_NETWORK))
        assertEquals(5, accountLike(senderName = true, serverRow = false).size)
    }

    @Test
    fun aListOpensAtTheTopUnlessAskedForARowItHas() {
        assertEquals(0, accountLike(senderName = true, serverRow = true).startIndex(null))
        // An RSS account has no network section.
        assertEquals(0, settingsRows { row { } }.startIndex(SETTINGS_ROW_NETWORK))
    }
}
