const DEFAULT_LOAD_INQUIRY = {
  name: 'Load inquiry',
  subject: 'Truck available — {{origin}} to {{destination}}',
  body:
    'Hi {{broker}},\n\n' +
    'We have a truck for your load from {{origin}} to {{destination}} ({{equipment}}, {{miles}}, {{rate}}).\n\n' +
    'Is this still available? We can cover it.\n\n' +
    'Thanks,',
  isDefault: true
};

const TEMPLATE_PLACEHOLDERS = [
  '{{origin}}',
  '{{destination}}',
  '{{miles}}',
  '{{rate}}',
  '{{ratePerMile}}',
  '{{broker}}',
  '{{equipment}}',
  '{{weight}}',
  '{{ref}}',
  '{{mc}}',
  '{{email}}'
];

module.exports = {
  DEFAULT_LOAD_INQUIRY,
  TEMPLATE_PLACEHOLDERS
};
