/**
 * Realistic freight email samples used to tune extraction / classification.
 * Run: node scripts/tune-freight-rules.js
 */
module.exports = [
  {
    id: 'broker-offer-1',
    from: 'john@abclogistics.com',
    to: 'mike@ourdesk.com',
    direction: 'inbound',
    subject: 'Load available - Chicago IL to Dallas TX - $2200',
    body: `Hi Mike,

We have a load available:

Load #: 784521
Pickup: Chicago, IL - 08/13
Delivery: Dallas, TX - 08/15
Equipment: Dry Van
Weight: 42,000 lbs
Miles: 925
Rate: $2,200 all-in

Need a truck ASAP. Please send carrier packet if interested.

Thanks,
John - ABC Logistics (Broker)`,
    expect: {
      partyType: 'broker',
      loadNumber: '784521',
      status: 'open',
      pickupState: 'IL',
      deliveryState: 'TX',
      rate: 2200,
      equipmentIncludes: 'VAN'
    }
  },
  {
    id: 'carrier-cover-1',
    from: 'dispatch@xyztrucking.com',
    to: 'mike@ourdesk.com',
    direction: 'inbound',
    subject: 'Re: Load 784521 Chicago to Dallas',
    body: `We can cover this load.

Driver empty in Joliet, can pick up tomorrow morning.
DOT 1234567
MC 987654

Please send rate confirmation.

Dispatch - XYZ Trucking`,
    expect: {
      partyType: 'carrier',
      loadNumber: '784521',
      status: 'booked',
      rate: null
    }
  },
  {
    id: 'negotiate-1',
    from: 'mike@ourdesk.com',
    to: 'john@abclogistics.com',
    direction: 'outbound',
    subject: 'Re: Load available - Chicago IL to Dallas TX',
    body: `Can you do $2,400 on load #784521?
Best rate we can work with right now.`,
    expect: {
      partyType: 'broker',
      loadNumber: '784521',
      status: 'negotiating',
      rate: 2400
    }
  },
  {
    id: 'booked-accept-1',
    from: 'john@abclogistics.com',
    to: 'mike@ourdesk.com',
    direction: 'inbound',
    subject: 'Re: Load #784521',
    body: `Yes, $2,400 works. We'll book it with your carrier.
Please send over the carrier packet and I'll issue the rate confirmation.`,
    expect: {
      partyType: 'broker',
      loadNumber: '784521',
      status: 'booked',
      rate: 2400
    }
  },
  {
    id: 'ratecon-1',
    from: 'ops@abclogistics.com',
    to: 'dispatch@xyztrucking.com',
    direction: 'inbound',
    subject: 'Rate Confirmation - Load 784521',
    body: `RATE CONFIRMATION ATTACHED

Load #: 784521
Shipper: ABC Logistics
Carrier: XYZ Trucking
Origin: Chicago, IL 60608
Destination: Dallas, TX 75201
PU: 08/13 0800
DEL: 08/15 1400
Equipment: 53' Dry Van
Rate: $2,400.00

Please sign and return RC.`,
    expect: {
      partyType: 'broker',
      loadNumber: '784521',
      status: 'confirmed',
      pickupState: 'IL',
      deliveryState: 'TX',
      rate: 2400
    }
  },
  {
    id: 'picked-up-1',
    from: 'dispatch@xyztrucking.com',
    to: 'ops@abclogistics.com',
    direction: 'inbound',
    subject: 'Re: Rate Confirmation - Load 784521',
    body: `Driver loaded at 09:15. Rolling to Dallas.
ETA delivery 08/15 afternoon.
In transit now.`,
    expect: {
      partyType: 'carrier',
      loadNumber: '784521',
      status: 'picked_up'
    }
  },
  {
    id: 'pod-1',
    from: 'dispatch@xyztrucking.com',
    to: 'ops@abclogistics.com',
    direction: 'inbound',
    subject: 'POD - Load 784521',
    body: `Delivered and unloaded. POD attached.
Please process payment for load #784521.`,
    expect: {
      partyType: 'carrier',
      loadNumber: '784521',
      status: 'delivered'
    }
  },
  {
    id: 'lost-1',
    from: 'sara@defbrokers.com',
    to: 'mike@ourdesk.com',
    direction: 'inbound',
    subject: 'Re: Houston TX to Atlanta GA load',
    body: `Thanks for checking - this load is covered already / going with another carrier.
Load ref HB-99210 is no longer available.`,
    expect: {
      partyType: 'broker',
      loadNumber: 'HB-99210',
      status: 'lost',
      pickupState: 'TX',
      deliveryState: 'GA'
    }
  },
  {
    id: 'inquiry-1',
    from: 'dispatch@fastfreight.com',
    to: 'mike@ourdesk.com',
    direction: 'inbound',
    subject: 'Is this load still available? DEN-PHX',
    body: `Hi, is this load still available?
Denver, CO to Phoenix, AZ
Looking for details on weight and rate.`,
    expect: {
      partyType: 'carrier',
      status: 'inquiry',
      pickupState: 'CO',
      deliveryState: 'AZ'
    }
  },
  {
    id: 'broker-lane-2',
    from: 'tenders@shipperlink.com',
    to: 'desk@ourdesk.com',
    direction: 'inbound',
    subject: 'NEW POSTING: Miami, FL → Orlando, FL | Van | $900',
    body: `New load posting from ShipperLink Brokerage:

REF: SL-44102
Origin: Miami, FL
Destination: Orlando, FL
Equip: VAN
Wt: 18k
Rate: $900
Commodity: retail

Please advise if you can cover.`,
    expect: {
      partyType: 'broker',
      loadNumber: 'SL-44102',
      status: 'open',
      pickupState: 'FL',
      deliveryState: 'FL',
      rate: 900
    }
  },
  {
    id: 'noise-github',
    from: 'noreply@github.com',
    to: 'mike@ourdesk.com',
    direction: 'inbound',
    subject: '[GitHub] Sudo email verification code',
    body: `Here is your GitHub sudo authentication code: 04684501`,
    expect: {
      skip: true
    }
  },
  {
    id: 'noise-newsletter',
    from: 'newsletter@rumble.com',
    to: 'mike@ourdesk.com',
    direction: 'inbound',
    subject: 'Community Update: Record Second Quarter',
    body: `RUM Group just had a record quarter. Unsubscribe here.`,
    expect: {
      skip: true
    }
  },
  {
    id: 'noise-vercel',
    from: 'notifications@vercel.com',
    to: 'mike@ourdesk.com',
    direction: 'inbound',
    subject: '9 domains need configuration on team projects',
    body: `Your Team has 9 misconfigured domains. Please update domain configurations.`,
    expect: { skip: true }
  },
  {
    id: 'noise-otp',
    from: 'security@accounts.google.com',
    to: 'mike@ourdesk.com',
    direction: 'inbound',
    subject: 'Your Google verification code',
    body: `G-123456 is your Google verification code.`,
    expect: { skip: true }
  },
  {
    id: 'noise-fake-delivery',
    from: 'hello@shopify.com',
    to: 'mike@ourdesk.com',
    direction: 'inbound',
    subject: 'Your order is out for delivery',
    body: `Your package is out for delivery today. Track shipment in your Shopify admin. Unsubscribe from this email.`,
    expect: { skip: true }
  },
  {
    id: 'broker-rpm-1',
    from: 'lanes@nationalbrokerage.com',
    to: 'rep@ourdesk.com',
    direction: 'inbound',
    subject: 'ATL GA - CLT NC dry van $1.85/mi',
    body: `Team,

Load available:
REF NB-77821
Atlanta, GA to Charlotte, NC
Dry Van / 38,000 lbs
Rate $1,450 all-in (~$1.85/mi)
PU tomorrow morning

Need a truck — send carrier packet.`,
    expect: {
      partyType: 'broker',
      loadNumber: 'NB-77821',
      status: 'open',
      pickupState: 'GA',
      deliveryState: 'NC',
      rate: 1450,
      equipmentIncludes: 'VAN'
    }
  },
  {
    id: 'carrier-eta-1',
    from: 'ops@midwestpower.com',
    to: 'lanes@nationalbrokerage.com',
    direction: 'inbound',
    subject: 'Re: REF NB-77821',
    body: `We can cover.

Driver empty in Marietta GA.
DOT #4455667
Please send the rate confirmation.

Dispatch - Midwest Power`,
    expect: {
      partyType: 'carrier',
      loadNumber: 'NB-77821',
      status: 'booked'
    }
  },
  {
    id: 'quoted-reply-noise',
    from: 'john@abclogistics.com',
    to: 'mike@ourdesk.com',
    direction: 'inbound',
    subject: 'Re: Load #784521',
    body: `Sounds good — booked at $2400.

Thanks,
John - ABC Logistics (Broker)

On Mon, Aug 11, 2026 at 10:02 AM Mike wrote:
> Can you do $2,400 on load #784521?
> Best rate we can work with right now.`,
    expect: {
      partyType: 'broker',
      loadNumber: '784521',
      status: 'booked',
      rate: 2400
    }
  }
];
