export type Customer = {
  id: string;
  name: string;
  billingCurrency: string;
};

export type BookingItem = {
  item: string;
  quantity: number;
};

export type Booking = {
  id: string;
  customer: Customer;
  items: BookingItem[];
};

const customers = {
  harbourline: { id: 'C-201', name: 'Harbourline Studios', billingCurrency: 'EUR' },
  northgate: { id: 'C-202', name: 'Northgate Analytics', billingCurrency: 'GBP' },
  bluepeak: { id: 'C-203', name: 'Bluepeak Outfitters', billingCurrency: 'USD' },
  sakuraLabs: { id: 'C-204', name: 'Sakura Lane Design', billingCurrency: 'JPY' },
  meridian: { id: 'C-205', name: 'Meridian Field Research', billingCurrency: 'EUR' },
} satisfies Record<string, Customer>;

export const bookings: Booking[] = [
  {
    id: 'B-1041',
    customer: customers.harbourline,
    items: [
      { item: 'Lisbon hotel', quantity: 3 },
      { item: 'Lisbon airport transfer', quantity: 2 },
    ],
  },
  {
    id: 'B-1042',
    customer: customers.sakuraLabs,
    items: [{ item: 'Kyoto hotel', quantity: 1 }],
  },
  {
    id: 'B-1043',
    customer: customers.northgate,
    items: [{ item: 'London hotel', quantity: 2 }],
  },
  {
    id: 'B-1044',
    customer: customers.bluepeak,
    items: [{ item: 'New York hotel', quantity: 4 }],
  },
  {
    id: 'B-1045',
    customer: customers.meridian,
    items: [
      { item: 'Kyoto hotel', quantity: 2 },
      { item: 'Kyoto station transfer', quantity: 2 },
    ],
  },
  {
    id: 'B-1046',
    customer: customers.northgate,
    items: [{ item: 'London hotel', quantity: 1 }],
  },
];

export function findBooking(id: string): Booking | undefined {
  return bookings.find((booking) => booking.id === id);
}
