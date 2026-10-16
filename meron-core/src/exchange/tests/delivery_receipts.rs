//! Delivery receipts asked of Exchange with the item it submits (ADR-0048,
//! ADR-0058), on recorded SOAP.

use super::scripted::{envelope, error_response, serve, Step};
use super::test_session;

fn created() -> String {
    envelope(
        r#"<m:CreateItemResponse><m:ResponseMessages><m:CreateItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items/></m:CreateItemResponseMessage></m:ResponseMessages></m:CreateItemResponse>"#,
    )
}

const RAW: &[u8] = b"From: me@example.org\r\nTo: you@example.org\r\nSubject: hi\r\n\r\nbody";

#[tokio::test]
async fn ews_delivery_receipt_success_asks_for_it_on_the_submitted_item() {
    let (url, server) = serve(vec![Step::Reply(created()), Step::Reply(created())]);
    let (mut session, _db) = test_session(url);
    session.send_mime(RAW.to_vec(), true).await.expect("sent asking");
    session.send_mime(RAW.to_vec(), false).await.expect("sent without asking");
    let requests = server.join().expect("server");

    let asked = &requests[0];
    assert!(asked.contains("<t:IsDeliveryReceiptRequested>true</t:IsDeliveryReceiptRequested>"), "{asked}");
    // Next to the content, after it, as the schema orders a message.
    let mime = asked.find("<t:MimeContent").expect("content");
    let flag = asked.find("<t:IsDeliveryReceiptRequested>").expect("flag");
    assert!(mime < flag, "{asked}");
    assert!(asked.contains("SendAndSaveCopy"), "{asked}");
    // The read receipt travels in the MIME (Disposition-Notification-To), not here.
    assert!(!asked.contains("IsReadReceiptRequested"), "{asked}");

    // Not asking changes nothing in the submission.
    assert!(!requests[1].contains("IsDeliveryReceiptRequested"), "{}", requests[1]);
}

#[tokio::test]
async fn ews_delivery_receipt_refusal_by_the_server_is_an_error_not_a_quiet_send() {
    let (url, server) = serve(vec![Step::Reply(error_response(
        "CreateItem",
        "ErrorAccessDenied",
        "Access is denied. Check credentials and try again.",
    ))]);
    let (mut session, _db) = test_session(url);
    let error = session.send_mime(RAW.to_vec(), true).await.expect_err("refused");
    assert!(format!("{error:#}").contains("ErrorAccessDenied"), "{error:#}");
    server.join().expect("server");
}

#[tokio::test]
async fn ews_delivery_receipt_with_a_lost_answer_fails_without_a_second_submission() {
    let (url, server) = serve(vec![Step::Drop]);
    let (mut session, _db) = test_session(url);
    let error = session.send_mime(RAW.to_vec(), true).await.expect_err("no answer");
    // A transport failure, which the send path marks as uncertain rather
    // than as refused (`classify_ews_send_error`): it may have gone.
    assert!(
        error.chain().any(|cause| cause.to_string().contains("EWS POST") || cause.downcast_ref::<std::io::Error>().is_some()),
        "{error:#}"
    );
    assert_eq!(server.join().expect("server").len(), 1, "sent once");
}

#[tokio::test]
async fn ews_delivery_receipt_is_reported_requested_through_the_shared_send_path() {
    use crate::smtp::DeliveryReceipt;
    let (url, server) = serve(vec![Step::Reply(created()), Step::Reply(created())]);
    let (session, _db) = test_session(url);
    let mut session = crate::backend::Session::Ews(session);
    // The same call the send path makes for Graph (#210): Exchange always
    // carries the request, whatever the Bcc or the protection.
    let asked = session.send_mime_with_receipt(RAW.to_vec(), true, true, true).await.expect("sent asking");
    assert_eq!(asked, (DeliveryReceipt::Requested, None));
    let not_asked = session.send_mime_with_receipt(RAW.to_vec(), false, false, false).await.expect("sent");
    assert_eq!(not_asked, (DeliveryReceipt::NotAsked, None));
    let requests = server.join().expect("server");
    assert!(requests[0].contains("<t:IsDeliveryReceiptRequested>true</t:IsDeliveryReceiptRequested>"));
    assert!(!requests[1].contains("IsDeliveryReceiptRequested"));
}
