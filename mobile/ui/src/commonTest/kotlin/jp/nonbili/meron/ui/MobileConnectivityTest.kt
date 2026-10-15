package jp.nonbili.meron.ui

import jp.nonbili.meron.shared.AccountSummary
import jp.nonbili.meron.shared.ProxySpec
import kotlinx.coroutines.CancellationException
import kotlin.coroutines.Continuation
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class MobileConnectivityTest {
    private val accounts =
        listOf(
            AccountSummary(id = "one", displayName = "Ping Chen", email = "ping.one@example.com"),
            AccountSummary(id = "two", displayName = "Ping Chen", email = "ping.two@example.com"),
            AccountSummary(id = "three", displayName = "Ada", email = "ada@example.com"),
        )

    @Test
    fun duplicateAccountNamesIncludeEmailAddress() {
        assertEquals("Ping Chen (ping.one@example.com)", mobileConnectivityAccountLabel("one", accounts))
        assertEquals("Ping Chen (ping.two@example.com)", mobileConnectivityAccountLabel("two", accounts))
        assertEquals("Ada", mobileConnectivityAccountLabel("three", accounts))
    }

    @Test
    fun accountLabelFallsBackSafely() {
        assertEquals("missing", mobileConnectivityAccountLabel("missing", accounts))
        assertNull(mobileConnectivityAccountLabel(null, accounts))
    }

    @Test
    fun extractsProxyEndpointsFromCoreErrors() {
        assertEquals(
            "127.0.0.1:1",
            mobileProxyEndpointFromSyncError(
                "sync inbox: connect to proxy 127.0.0.1:1: tcp connect: Connection refused",
            ),
        )
        assertEquals(
            "proxy.example:1080",
            mobileProxyEndpointFromSyncError("socks5 proxy proxy.example:1080 to imap.example:993: timed out"),
        )
        assertEquals(
            "::1:9050",
            mobileProxyEndpointFromSyncError("connect to proxy ::1:9050: Connection refused"),
        )
        assertNull(mobileProxyEndpointFromSyncError("connect imap.example:993: timed out"))
    }

    @Test
    fun aRefusedProxySettingNamesWhoseSettingItIs() {
        // As meron-core/src/proxy.rs writes it (#201), from IMAP and from Graph.
        assertEquals(
            MobileProxyScope.App,
            mobileUnusableProxyScopeFromSyncError(
                "sync INBOX: proxy setting unusable (app): the app's proxy is incomplete (server or port missing)",
            ),
        )
        assertEquals(
            MobileProxyScope.Account,
            mobileUnusableProxyScopeFromSyncError(
                "sync INBOX: proxy setting unusable (account): this account's proxy has an unknown type \"ftp\"",
            ),
        )
        assertEquals(
            MobileProxyScope.App,
            mobileUnusableProxyScopeFromSyncError("folders sync: Microsoft Graph: proxy setting unusable (app)"),
        )
        assertNull(mobileUnusableProxyScopeFromSyncError("connect to proxy 127.0.0.1:1: Connection refused"))
        assertNull(mobileUnusableProxyScopeFromSyncError("Microsoft Graph: Transport"))
        assertNull(mobileUnusableProxyScopeFromSyncError("proxy setting unusable (other): x"))
    }

    @Test
    fun proxyFailuresOpenTheSettingThatFixesThem() {
        val follows = AccountSummary(id = "work", email = "work@example.com")
        val own =
            AccountSummary(
                id = "home",
                email = "home@example.com",
                proxy = ProxySpec(mode = "socks5", host = "proxy.home", port = 1080),
            )
        val appRefusal = "sync INBOX: proxy setting unusable (app): the app's proxy is incomplete"
        val accountRefusal = "sync INBOX: proxy setting unusable (account): this account's proxy is incomplete"
        // A refusal names its setting, whatever the account uses.
        assertEquals(MobileProxyScope.App, mobileProxySettingsScope(appRefusal, own))
        assertEquals(MobileProxyScope.Account, mobileProxySettingsScope(accountRefusal, follows))
        // A proxy that did not answer: the account's own, or the app's it follows.
        val unreachable = "sync INBOX: connect to proxy proxy.home:1080: Connection refused"
        assertEquals(MobileProxyScope.Account, mobileProxySettingsScope(unreachable, own))
        assertEquals(MobileProxyScope.App, mobileProxySettingsScope(unreachable, follows))
        assertEquals(MobileProxyScope.App, mobileProxySettingsScope(unreachable, null))
        // An account's own proxy with no known account: no account settings to
        // open, so the general Network settings rather than the Settings root.
        assertEquals(MobileProxyScope.App, mobileProxySettingsScope(accountRefusal, null))
        // Anything else is not the proxy's.
        assertNull(mobileProxySettingsScope("sync INBOX: connect imap.example:993: timed out", own))
    }

    @Test
    fun accountContextPreservesFailureAndCancellation() {
        val failure =
            assertFailsWith<AccountSyncException> {
                runSuspend {
                    withSyncAccountContext("one") {
                        throw IllegalStateException("proxy failed")
                    }
                }
            }
        assertEquals("one", failure.accountId)
        assertEquals("proxy failed", failure.message)

        assertFailsWith<CancellationException> {
            runSuspend {
                withSyncAccountContext("one") {
                    throw CancellationException("cancelled")
                }
            }
        }
    }

    private fun <T> runSuspend(block: suspend () -> T): T {
        var completed: Result<T>? = null
        block.startCoroutine(
            object : Continuation<T> {
                override val context = EmptyCoroutineContext

                override fun resumeWith(result: Result<T>) {
                    completed = result
                }
            },
        )
        return checkNotNull(completed).getOrThrow()
    }
}
