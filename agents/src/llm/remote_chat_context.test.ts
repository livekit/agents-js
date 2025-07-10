// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatMessage } from './chat_context.js';
import { RemoteChatContext } from './remote_chat_context.js';

function createMessage(id: string, content: string): ChatMessage {
  return new ChatMessage({ id, role: 'user', content });
}

describe('RemoteChatContext', () => {
  let context: RemoteChatContext;

  beforeEach(() => {
    context = new RemoteChatContext();
  });

  describe('empty context', () => {
    it('should return empty ChatContext', () => {
      const chatCtx = context.toChatCtx();
      expect(chatCtx.items).toHaveLength(0);
    });

    it('should return null for non-existent item', () => {
      expect(context.get('nonexistent')).toBeNull();
    });

    it('should throw error when deleting non-existent item', () => {
      expect(() => context.delete('nonexistent')).toThrow('Item with ID nonexistent not found');
    });
  });

  describe('single item operations', () => {
    it('should insert single item at head', () => {
      const msg = createMessage('msg1', 'Hello');
      context.insert(undefined, msg);

      expect(context.get('msg1')).toBeDefined();
      expect(context.get('msg1')!.item).toBe(msg);
      expect(context.toChatCtx().items).toEqual([msg]);
    });

    it('should delete single item', () => {
      const msg = createMessage('msg1', 'Hello');
      context.insert(undefined, msg);
      context.delete('msg1');

      expect(context.get('msg1')).toBeNull();
      expect(context.toChatCtx().items).toHaveLength(0);
    });
  });

  describe('multiple item operations', () => {
    it('should insert multiple items at head', () => {
      const msg1 = createMessage('msg1', 'First');
      const msg2 = createMessage('msg2', 'Second');
      const msg3 = createMessage('msg3', 'Third');

      context.insert(undefined, msg1);
      context.insert(undefined, msg2);
      context.insert(undefined, msg3);

      expect(context.toChatCtx().items).toEqual([msg3, msg2, msg1]);
    });

    it('should insert items after specific nodes', () => {
      const msg1 = createMessage('msg1', 'First');
      const msg2 = createMessage('msg2', 'Second');
      const msg3 = createMessage('msg3', 'Third');

      context.insert(undefined, msg1);
      context.insert('msg1', msg2);
      context.insert('msg1', msg3);

      expect(context.toChatCtx().items).toEqual([msg1, msg3, msg2]);
    });

    it('should insert at tail', () => {
      const msg1 = createMessage('msg1', 'First');
      const msg2 = createMessage('msg2', 'Second');
      const msg3 = createMessage('msg3', 'Third');

      context.insert(undefined, msg1);
      context.insert('msg1', msg2);
      context.insert('msg2', msg3);

      expect(context.toChatCtx().items).toEqual([msg1, msg2, msg3]);
    });
  });

  describe('deletion edge cases', () => {
    it('should delete head node from multi-item list', () => {
      const msg1 = createMessage('msg1', 'First');
      const msg2 = createMessage('msg2', 'Second');
      const msg3 = createMessage('msg3', 'Third');

      context.insert(undefined, msg1);
      context.insert('msg1', msg2);
      context.insert('msg2', msg3);

      context.delete('msg1');
      expect(context.toChatCtx().items).toEqual([msg2, msg3]);
    });

    it('should delete tail node from multi-item list', () => {
      const msg1 = createMessage('msg1', 'First');
      const msg2 = createMessage('msg2', 'Second');
      const msg3 = createMessage('msg3', 'Third');

      context.insert(undefined, msg1);
      context.insert('msg1', msg2);
      context.insert('msg2', msg3);

      context.delete('msg3');
      expect(context.toChatCtx().items).toEqual([msg1, msg2]);
    });

    it('should delete middle node from multi-item list', () => {
      const msg1 = createMessage('msg1', 'First');
      const msg2 = createMessage('msg2', 'Second');
      const msg3 = createMessage('msg3', 'Third');

      context.insert(undefined, msg1);
      context.insert('msg1', msg2);
      context.insert('msg2', msg3);

      context.delete('msg2');
      expect(context.toChatCtx().items).toEqual([msg1, msg3]);
    });

    it('should handle multiple deletions', () => {
      const msg1 = createMessage('msg1', 'First');
      const msg2 = createMessage('msg2', 'Second');
      const msg3 = createMessage('msg3', 'Third');
      const msg4 = createMessage('msg4', 'Fourth');

      context.insert(undefined, msg1);
      context.insert('msg1', msg2);
      context.insert('msg2', msg3);
      context.insert('msg3', msg4);

      context.delete('msg2');
      context.delete('msg4');
      expect(context.toChatCtx().items).toEqual([msg1, msg3]);

      context.delete('msg1');
      expect(context.toChatCtx().items).toEqual([msg3]);

      context.delete('msg3');
      expect(context.toChatCtx().items).toHaveLength(0);
    });
  });

  describe('error conditions', () => {
    it('should throw error when inserting duplicate ID', () => {
      const msg1 = createMessage('msg1', 'First');
      const msg2 = createMessage('msg1', 'Duplicate');

      context.insert(undefined, msg1);
      expect(() => context.insert(undefined, msg2)).toThrow('Item with ID msg1 already exists.');
    });

    it('should throw error when inserting after non-existent ID', () => {
      const msg = createMessage('msg1', 'Hello');
      expect(() => context.insert('nonexistent', msg)).toThrow(
        'previousItemId nonexistent not found',
      );
    });

    it('should throw error when deleting non-existent ID', () => {
      expect(() => context.delete('nonexistent')).toThrow('Item with ID nonexistent not found');
    });
  });

  describe('complex scenarios', () => {
    it('should handle interleaved inserts and deletes', () => {
      const msg1 = createMessage('msg1', 'A');
      const msg2 = createMessage('msg2', 'B');
      const msg3 = createMessage('msg3', 'C');
      const msg4 = createMessage('msg4', 'D');

      context.insert(undefined, msg1);
      context.insert('msg1', msg2);
      context.delete('msg1');
      context.insert('msg2', msg3);
      context.insert(undefined, msg4);

      expect(context.toChatCtx().items).toEqual([msg4, msg2, msg3]);
    });

    it('should maintain correct pointers after complex operations', () => {
      const msg1 = createMessage('msg1', 'A');
      const msg2 = createMessage('msg2', 'B');
      const msg3 = createMessage('msg3', 'C');
      const msg4 = createMessage('msg4', 'D');
      const msg5 = createMessage('msg5', 'E');

      context.insert(undefined, msg1);
      context.insert('msg1', msg2);
      context.insert('msg2', msg3);
      context.insert('msg1', msg4);
      context.insert('msg4', msg5);

      expect(context.toChatCtx().items).toEqual([msg1, msg4, msg5, msg2, msg3]);

      context.delete('msg4');
      expect(context.toChatCtx().items).toEqual([msg1, msg5, msg2, msg3]);

      context.delete('msg1');
      expect(context.toChatCtx().items).toEqual([msg5, msg2, msg3]);

      context.delete('msg2');
      expect(context.toChatCtx().items).toEqual([msg5, msg3]);
    });

    it('should handle rebuilding from scratch', () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        createMessage(`msg${i}`, `Content ${i}`),
      );

      for (const msg of messages) {
        context.insert(undefined, msg);
      }

      expect(context.toChatCtx().items).toEqual([...messages].reverse());

      for (let i = 0; i < 5; i++) {
        context.delete(`msg${i}`);
      }

      const remaining = [...messages]
        .reverse()
        .filter((msg) => !['msg0', 'msg1', 'msg2', 'msg3', 'msg4'].includes(msg.id));
      expect(context.toChatCtx().items).toEqual(remaining);
    });
  });

  describe('get method', () => {
    it('should return correct item for existing ID', () => {
      const msg1 = createMessage('msg1', 'Hello');
      const msg2 = createMessage('msg2', 'World');

      context.insert(undefined, msg1);
      context.insert('msg1', msg2);

      const retrieved = context.get('msg2');
      expect(retrieved).toBeDefined();
      expect(retrieved!.item).toBe(msg2);
    });

    it('should return null for non-existent ID', () => {
      const msg = createMessage('msg1', 'Hello');
      context.insert(undefined, msg);

      expect(context.get('nonexistent')).toBeNull();
    });
  });

  describe('toChatCtx method', () => {
    it('should preserve order in ChatContext', () => {
      const msg1 = createMessage('msg1', 'First');
      const msg2 = createMessage('msg2', 'Second');
      const msg3 = createMessage('msg3', 'Third');

      context.insert(undefined, msg1);
      context.insert('msg1', msg2);
      context.insert('msg2', msg3);

      const chatCtx = context.toChatCtx();
      expect(chatCtx.items).toEqual([msg1, msg2, msg3]);
    });

    it('should work with empty context', () => {
      const chatCtx = context.toChatCtx();
      expect(chatCtx.items).toHaveLength(0);
    });

    it('should create new ChatContext instance', () => {
      const msg = createMessage('msg1', 'Hello');
      context.insert(undefined, msg);

      const chatCtx1 = context.toChatCtx();
      const chatCtx2 = context.toChatCtx();

      expect(chatCtx1).not.toBe(chatCtx2);
      expect(chatCtx1.items).toEqual(chatCtx2.items);
    });
  });
});
