import { OrderCancelled } from '../../events/domain-events/order-cancelled.event';
import { CustomerId } from '../customer.entity';
import { EventSpotId } from '../event-spot';
import { Order, OrderStatus } from '../order.entity';

describe('Order Entity Unit Tests', () => {
  const createOrder = () =>
    Order.create({
      customer_id: new CustomerId(),
      event_spot_id: new EventSpotId(),
      amount: 100,
    });

  test('deve cancelar um pedido pago', () => {
    const order = createOrder();
    order.pay();
    order.clearEvents();

    order.cancel();

    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.events.size).toBe(1);
    const [event] = [...order.events] as OrderCancelled[];
    expect(event).toBeInstanceOf(OrderCancelled);
    expect(event.aggregate_id.equals(order.id)).toBe(true);
    expect(event.status).toBe(OrderStatus.CANCELLED);
    expect(event.event_spot_id.equals(order.event_spot_id)).toBe(true);
  });

  test('deve cancelar um pedido pendente', () => {
    const order = createOrder();

    order.cancel();

    expect(order.status).toBe(OrderStatus.CANCELLED);
  });

  test('não deve cancelar um pedido já cancelado', () => {
    const order = createOrder();
    order.cancel();
    order.clearEvents();

    expect(() => order.cancel()).toThrowError('Order already cancelled');
    expect(order.events.size).toBe(0);
  });

  test('deve expor o status legível no toJSON', () => {
    const order = createOrder();
    order.cancel();

    expect(order.toJSON().status).toBe('CANCELLED');
  });
});
