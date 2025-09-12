export function orderUid() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = 'O_';
    for (let i = 0; i < 6; i++) {
        result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return result;
}
export class OrderState {
    items = {};
    async add(item) {
        this.items[item.orderId] = item;
    }
    async remove(orderId) {
        const item = this.items[orderId];
        if (!item) {
            throw new Error(`Order item with ID ${orderId} not found`);
        }
        delete this.items[orderId];
        return item;
    }
    get(orderId) {
        return this.items[orderId];
    }
}
export function createOrderedCombo(params) {
    return {
        type: 'combo_meal',
        orderId: orderUid(),
        ...params,
    };
}
export function createOrderedHappy(params) {
    return {
        type: 'happy_meal',
        orderId: orderUid(),
        ...params,
    };
}
export function createOrderedRegular(params) {
    return {
        type: 'regular',
        orderId: orderUid(),
        ...params,
    };
}
//# sourceMappingURL=order.js.map