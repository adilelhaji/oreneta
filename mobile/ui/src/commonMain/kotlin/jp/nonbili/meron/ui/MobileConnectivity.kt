package jp.nonbili.meron.ui

import jp.nonbili.meron.shared.AccountSummary
import jp.nonbili.meron.shared.AddPasswordAccountParams
import jp.nonbili.meron.shared.CertificateProtocol
import jp.nonbili.meron.shared.SendMailParams
import jp.nonbili.meron.shared.ServerCertificate
import kotlinx.coroutines.CancellationException

internal data class MobileSyncError(
    val accountId: String?,
    val message: String,
)

/**
 * A server certificate the user is being asked to trust, and the account and
 * server it belongs to. [protocol] decides which pin an acceptance writes.
 */
internal data class MobileCertPrompt(
    val accountId: String,
    val host: String,
    val port: Int,
    val protocol: CertificateProtocol,
    val certificate: ServerCertificate,
    val retry: PendingCertificateRetry?,
)

/** A prepared message whose send failed and can be retried as-is. */
internal data class PendingComposeSend(
    val accountId: String,
    val params: SendMailParams,
    val composeSessionGeneration: Int,
    val draftOwners: List<ComposeDraftOwner>,
)

/** An immutable quick reply, including the optimistic bubble it owns. */
internal data class PendingQuickReplySend(
    val accountId: String,
    val params: SendMailParams,
    val tempMessageId: String,
    val threadId: String,
    val draftOwner: ComposeDraftOwner?,
    val quickReplyGeneration: Int,
)

internal sealed interface PendingCertificateRetry {
    val accountId: String

    data class Compose(
        val pending: PendingComposeSend,
    ) : PendingCertificateRetry {
        override val accountId: String = pending.accountId
    }

    data class QuickReply(
        val pending: PendingQuickReplySend,
    ) : PendingCertificateRetry {
        override val accountId: String = pending.accountId
    }

    /**
     * A server-settings save a certificate refusal interrupted. It carries the
     * edited servers because they are *not* stored yet — the save failed — so
     * both the probe and the retry have to use what the user typed rather than
     * the account's current values.
     */
    data class ServerSettings(
        override val accountId: String,
        val draft: ServerSettingsDraft,
    ) : PendingCertificateRetry

    /**
     * An account creation a certificate refusal interrupted. Unlike every other
     * case there is no stored account yet, so the accepted pin cannot be written
     * to a row and read back — it has to ride along on the request that retries.
     * [accountId] is the id the core will mint for this address.
     */
    data class AddAccount(
        override val accountId: String,
        val params: AddPasswordAccountParams,
    ) : PendingCertificateRetry
}

internal fun certificateErrorAccountId(
    selectedAccountId: String?,
    retry: PendingCertificateRetry?,
): String? = retry?.accountId ?: selectedAccountId

internal class AccountSyncException(
    val accountId: String,
    cause: Throwable,
) : Exception(cause.message, cause)

internal suspend fun <T> withSyncAccountContext(
    accountId: String,
    block: suspend () -> T,
): T =
    try {
        block()
    } catch (failure: CancellationException) {
        throw failure
    } catch (failure: Throwable) {
        throw AccountSyncException(accountId, failure)
    }

internal fun mobileConnectivityAccountLabel(
    accountId: String?,
    accounts: List<AccountSummary>,
): String? {
    if (accountId.isNullOrBlank()) return null
    val account = accounts.firstOrNull { it.id == accountId } ?: return accountId
    val displayName = account.displayName.trim()
    val email = account.email.trim()
    if (displayName.isBlank()) return email.ifBlank { account.id }

    val duplicateName =
        accounts.any { candidate ->
            candidate.id != account.id &&
                candidate.displayName.trim().equals(displayName, ignoreCase = true)
        }
    return if (duplicateName && email.isNotBlank() && !email.equals(displayName, ignoreCase = true)) {
        "$displayName ($email)"
    } else {
        displayName
    }
}

internal fun mobileProxyEndpointFromSyncError(error: String): String? {
    val endpoint = """([^\s]+:\d+)"""
    return Regex("""\bconnect to proxy\s+$endpoint""", RegexOption.IGNORE_CASE).find(error)?.groupValues?.get(1)
        ?: Regex("""\b(?:http|socks5) proxy\s+$endpoint""", RegexOption.IGNORE_CASE).find(error)?.groupValues?.get(1)
}

/** Whose proxy setting it is: the app-wide one or the account's own. */
internal enum class MobileProxyScope { App, Account }

/**
 * The core refuses a proxy that was chosen but cannot be used (no server or
 * port, an unknown type, a setting it could not read) with one form of text,
 * `UNUSABLE_PREFIX` in meron-core/src/proxy.rs (#201):
 * "proxy setting unusable (app): …" or "proxy setting unusable (account): …".
 * Change both together.
 */
internal fun mobileUnusableProxyScopeFromSyncError(error: String): MobileProxyScope? =
    when (Regex("""\bproxy setting unusable \((app|account)\)""").find(error)?.groupValues?.get(1)) {
        "app" -> MobileProxyScope.App
        "account" -> MobileProxyScope.Account
        else -> null
    }

/**
 * Which proxy setting fixes a sync failure, or null when the failure was not
 * the proxy's. A refusal names its setting; for a proxy that did not answer it
 * is the account's own when the account has one, otherwise the app-wide one it
 * follows.
 */
internal fun mobileProxySettingsScope(
    error: String,
    account: AccountSummary?,
): MobileProxyScope? {
    mobileUnusableProxyScopeFromSyncError(error)?.let { return it }
    if (mobileProxyEndpointFromSyncError(error) == null) return null
    val mode = account?.proxy?.mode
    return if (mode == "http" || mode == "socks5") MobileProxyScope.Account else MobileProxyScope.App
}
