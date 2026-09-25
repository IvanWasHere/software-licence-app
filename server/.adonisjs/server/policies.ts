export const policies = {
  ApiKeyPolicy: () => import('#app/policies/api_key_policy'),
  FilePolicy: () => import('#app/policies/file_policy'),
  InvitationPolicy: () => import('#app/policies/invitation_policy'),
  MemberPolicy: () => import('#app/policies/member_policy'),
  OrganizationPolicy: () => import('#app/policies/organization_policy'),
  SupportTicketPolicy: () => import('#app/policies/support_ticket_policy'),
}

