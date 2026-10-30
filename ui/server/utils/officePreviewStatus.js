// ui/server/utils/officePreviewStatus.js
//
// `/api/office-preview/status` exists so the editor knows whether an Office
// file can be rendered. Everything else it used to return — the configured
// binary path and the full candidate scan — is host filesystem detail that
// belongs to the operator, not to every logged-in user. Normal users get the
// yes/no answer; administrators (who own the Office preview settings page)
// keep the full payload.
export function shapeOfficePreviewStatus(payload, role) {
  if (role === 'admin') return payload;
  return {
    service: payload?.service,
    libreOffice: { available: Boolean(payload?.libreOffice?.available) },
    supportedServices: payload?.supportedServices,
  };
}
