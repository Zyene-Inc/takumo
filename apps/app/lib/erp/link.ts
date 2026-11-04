// Where an email about one ERP report should land: the report itself, with
// its columns open.

const PAGE = "/settings/integrations/email";

export const reportLink = (reportId?: string) =>
  reportId ? `${PAGE}?report=${reportId}#report-${reportId}` : PAGE;
