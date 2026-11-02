# Getting RFQs into Takumo

Every RFQ lands in the same inbox (`/quotes`), whatever channel it came through. Each RFQ records its channel (`Rfq.source`): `email`, `portal`, `form`, `phone`, `upload` or `paste`. The inbox and metrics use it.

Each shop has an RFQ address: `rfq-<code>@<inbound domain>`. You'll find it under **Settings → Integrations → Email & ERP reports**. Mail to it is only accepted from senders on its allowed list, and only when SPF/DKIM pass (see `docs/DEPLOY.md`).

## Email (Outlook, Gmail)
Connect the mailbox under **Settings → Integrations**. RFQs are picked up automatically, using the shop's RFQ rules. You can also forward any RFQ to the RFQ address.

## Customer portals
Choose one of these:
- **Notifications:** set the portal (Ariba, Coupa, Jaggaer, Plex, Paperless Parts, Xometry and others) to email its RFQ notifications to the RFQ address, or forward them. Add the portal's sending address, or `@its-domain`, to the allowed list. Mail from known portal domains is marked **Customer portal**.
- **The package:** download the RFQ package (PDF, drawings, STEP files or a zip) and drop it on **Quotes → New RFQ → Upload files**. Choose "a customer portal" under "It came from".

## Website contact form
In your form tool (WordPress/WPForms, Gravity Forms, Webflow, Squarespace, Wix, HubSpot, Jotform, Typeform, Formspree and others), add the RFQ address as a notification recipient. Then add the form's sending address, often `wordpress@yourdomain` or the form service's domain, to the allowed list.

A submission is marked **Website form** when any of these is true:
- it comes from a known form service;
- the sender is a form mailer address such as `wordpress@`, `forms@` or `webform@`;
- the subject reads like a form notification;
- the body is a "Name: / Email: / Message:" list.

## Phone calls
Use **Quotes → New RFQ → From a call**. Type, or use **Dictate** right after the call. The transcript becomes the RFQ text and Takumo reads it like any other RFQ.

## Files
Every file that comes with an RFQ is kept with it: attachments, the uploaded package, and what's inside a zip. Each file is classed as drawing, 3D model, document or image. They're listed on the RFQ page and can be downloaded. PDFs and images can also be viewed in a locked-down browser tab.

Limits:
- 20 MB per file, 50 MB and 60 files per RFQ.
- A zip unpacks at most 200 entries and 100 MB.
- Uploads on `/quotes` take up to 20 MB at once. Bigger packages go by email to the RFQ address.

Anything left out is listed on the RFQ page. Email signature logos (images under 15 KB) aren't kept.

## The same RFQ twice
If the same sender sends the same set of files again within 7 days, no new RFQ is made. A mailbox check notes "same as RFQ-0012", the inbound message log says the same, and an upload shows a link to the earlier RFQ. Separately, replies in a connected mailbox thread with the same attachments are skipped (Phase 1).

## EDI
Not supported in v1 (see the product plan, §12).
