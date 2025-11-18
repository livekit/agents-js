// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// Ref: Python telemetry/traces.py lines 181-398 (_to_proto_chat_item, _to_rfc3339, _upload_session_report)
// This file corresponds to the Python session report upload implementation
import { SeverityNumber, logs } from '@opentelemetry/api-logs';
import FormData from 'form-data';
import { AccessToken } from 'livekit-server-sdk';
import { log } from '../log.js';
import type { SessionReport } from './report.js';
import { sessionReportToJSON } from './report.js';

/**
 * Upload session report to LiveKit Cloud.
 * Ref: Python telemetry/traces.py lines 283-398 (_upload_session_report)
 *
 * Does TWO things (matching Python):
 * 1. Logs chat history to OTEL (lines 291-344)
 * 2. Uploads multipart form to Cloud (lines 347-398)
 *
 * @param options - Upload configuration
 * @param report - Session report to upload
 */
export async function uploadSessionReport(options: {
  roomId: string;
  jobId: string;
  cloudHostname: string;
  report: SessionReport;
  apiKey?: string;
  apiSecret?: string;
}): Promise<void> {
  const { roomId, jobId, cloudHostname, report } = options;
  const logger = log();

  // Ref: Python lines 291-298 - Create chat_history logger and log chat items
  const chatLogger = logs.getLoggerProvider().getLogger('chat_history');

  // Ref: Python lines 320-327 - Log session report metadata
  chatLogger.emit({
    body: 'session report',
    timestamp: report.timestamp * 1e6, // Convert to nanoseconds
    severityNumber: SeverityNumber.UNSPECIFIED,
    severityText: 'unspecified',
    attributes: {
      room_id: report.roomId,
      job_id: report.jobId,
      room: report.room,
      'session.options': JSON.stringify(report.options),
      'session.report_timestamp': report.timestamp,
    },
  } as any);

  // Ref: Python lines 329-344 - Log each chat item
  for (const item of report.chatHistory.items) {
    const itemLog = item.toJSON(false); // exclude_timestamp=false
    let severityNumber = SeverityNumber.UNSPECIFIED;
    let severityText = 'unspecified';

    // Set ERROR severity for failed function calls
    if (item.type === 'function_call_output' && (item as any).isError) {
      severityNumber = SeverityNumber.ERROR;
      severityText = 'error';
    }

    chatLogger.emit({
      body: 'chat item',
      timestamp: (item.createdAt || Date.now()) * 1e6, // Convert to nanoseconds
      severityNumber,
      severityText,
      attributes: {
        'chat.item': itemLog,
      },
    } as any);
  }

  const apiKey = options.apiKey || process.env.LIVEKIT_API_KEY;
  const apiSecret = options.apiSecret || process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set for session report upload');
  }

  // Ref: Python lines 347-352 - Create access token with observability grants
  const token = new AccessToken(apiKey, apiSecret, {
    identity: 'livekit-agents-session-report',
    ttl: '6h',
  });
  token.addObservabilityGrant({ write: true });
  const jwt = await token.toJwt();

  // Ref: Python lines 354-359 - Create protobuf header
  // TODO(brian): PR6 - Use protobuf MetricsRecordingHeader instead of JSON when proto support added
  const header = {
    room_id: roomId,
    // TODO(brian): PR6 - Add duration and start_time when audio recording is implemented
    duration: 0,
    start_time: 0,
  };

  // Ref: Python lines 361-366 - Create multipart form
  const form = new FormData();

  // Header part (using JSON instead of protobuf for TypeScript)
  form.append('header', JSON.stringify(header), {
    filename: 'header.json',
    contentType: 'application/json',
  });

  // Ref: Python lines 368-372 - Chat history part
  const chatHistoryJson = JSON.stringify(sessionReportToJSON(report));
  form.append('chat_history', chatHistoryJson, {
    filename: 'chat_history.json',
    contentType: 'application/json',
  });

  // TODO(brian): PR6 - Add audio recording part when RecorderIO is implemented
  // Ref: Python lines 374-386 - Audio recording part (if available)
  // if (report.audioRecordingPath && report.audioRecordingStartedAt) {
  //   const audioBytes = await readFile(report.audioRecordingPath);
  //   form.append('audio', audioBytes, {
  //     filename: 'recording.ogg',
  //     contentType: 'audio/ogg',
  //   });
  // }

  // Ref: Python lines 388-396 - Upload to LiveKit Cloud
  const url = `https://${cloudHostname}/observability/recordings/v0`;
  const headers = {
    Authorization: `Bearer ${jwt}`,
    ...form.getHeaders(),
  };

  logger.debug('uploading session report to LiveKit Cloud');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: form as any,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    logger.debug('finished uploading session report');
  } catch (error) {
    logger.error({ error }, 'failed to upload session report');
    throw error;
  }
}
