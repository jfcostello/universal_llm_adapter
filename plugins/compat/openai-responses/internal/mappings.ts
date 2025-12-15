export type ResponsesAPIContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | {
      type: 'input_file';
      filename?: string;
      file_data?: string;
      file_id?: string;
    }
  | Record<string, any>;

export type ResponsesAPIInputItem =
  | {
      role: 'system' | 'user' | 'assistant';
      content: string | ResponsesAPIContentPart[];
    }
  | {
      type: 'function_call';
      id: string;
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: 'function_call_output';
      id: string;
      call_id: string;
      output: string;
    }
  | Record<string, any>;

