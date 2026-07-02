// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ChatContext } from './chat_context.js';
import type { ChatItem } from './chat_context.js';

export interface RemoteChatItem {
  item: ChatItem;
  /** @internal */
  _prev?: RemoteChatItem | null;
  /** @internal */
  _next?: RemoteChatItem | null;
}

export class RemoteChatContext {
  private head?: RemoteChatItem | null;
  private tail?: RemoteChatItem | null;
  private idToItem: Record<string, RemoteChatItem> = {};

  toChatCtx(): ChatContext {
    const items: ChatItem[] = [];
    let currentNode = this.head;
    while (currentNode) {
      items.push(currentNode.item);
      currentNode = currentNode._next;
    }

    return new ChatContext(items);
  }

  get(itemId: string): RemoteChatItem | null {
    return this.idToItem[itemId] ?? null;
  }

  /**
   * Insert `message` after the node with ID `previousItemId`.
   * If `previousItemId` is undefined, insert at the head.
   * @param previousItemId - The ID of the item after which to insert the new item.
   * @param message - The item to insert.
   */
  insert(previousItemId: string | undefined, message: ChatItem): void {
    const itemId = message.id;

    if (itemId in this.idToItem) {
      throw new Error(`Item with ID ${itemId} already exists.`);
    }

    const newNode: RemoteChatItem = { item: message };

    if (!previousItemId) {
      if (this.head) {
        newNode._next = this.head;
        this.head._prev = newNode;
      } else {
        this.tail = newNode;
      }
      this.head = newNode;
      this.idToItem[itemId] = newNode;
      return;
    }

    const prevNode = this.idToItem[previousItemId];
    if (!prevNode) {
      throw new Error(`previousItemId ${previousItemId} not found`);
    }

    newNode._prev = prevNode;
    newNode._next = prevNode._next;

    prevNode._next = newNode;

    if (newNode._next) {
      newNode._next._prev = newNode;
    } else {
      this.tail = newNode;
    }

    this.idToItem[itemId] = newNode;
  }

  delete(itemId: string): void {
    const node = this.idToItem[itemId];
    if (!node) {
      throw new Error(`Item with ID ${itemId} not found`);
    }

    const prevNode = node._prev;
    const nextNode = node._next;

    if (this.head === node) {
      this.head = nextNode;
      if (this.head) {
        this.head._prev = undefined;
      }
    } else {
      if (prevNode) {
        prevNode._next = nextNode;
      }
    }

    if (this.tail === node) {
      this.tail = prevNode;
      if (this.tail) {
        this.tail._next = undefined;
      }
    } else {
      if (nextNode) {
        nextNode._prev = prevNode;
      }
    }

    delete this.idToItem[itemId];
  }
}
