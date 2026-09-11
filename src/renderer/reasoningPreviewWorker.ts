import type { AgentMessageDeltaStream } from '../shared/types.js';
import { prepareReasoningDeltaForDisplay } from '../shared/reasoningPreview.js';

interface ReasoningPreviewWorkerRequest {
  id: number;
  payload: AgentMessageDeltaStream;
}

interface ReasoningPreviewWorkerResponse {
  id: number;
  payload: AgentMessageDeltaStream;
}

self.onmessage = (event: MessageEvent<ReasoningPreviewWorkerRequest>) => {
  const response: ReasoningPreviewWorkerResponse = {
    id: event.data.id,
    payload: prepareReasoningDeltaForDisplay(event.data.payload)
  };
  self.postMessage(response);
};
