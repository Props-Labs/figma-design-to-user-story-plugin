// This plugin will open a window to prompt the user to enter a number, and
// it will then create that many rectangles on the screen.

// This file holds the main code for plugins. Code in this file has access to
// the *figma document* via the figma global object.
// You can access browser APIs in the <script> tag inside "ui.html" which has a
// full browser environment (See https://www.figma.com/plugin-docs/how-plugins-run).

// Show the plugin UI
figma.showUI(__html__, { width: 450, height: 550 });

// Function to get selected flow
function getSelectedFlow(): FrameNode | null {
  const selection = figma.currentPage.selection;
  if (selection.length === 0 || !(selection[0].type === 'FRAME')) {
    figma.ui.postMessage({ type: 'no-selection', message: 'Please select a frame within a prototype flow' });
    return null;
  }
  // Return the selected frame as the starting point of the flow
  return selection[0] as FrameNode;
}

// Function to check for selected flow and update UI
async function updateSelectedFlow() {
  const selectedFlow = getSelectedFlow();
  if (selectedFlow) {
    try {
      figma.ui.postMessage({ type: 'processing', message: 'Analyzing flow...' });
      const flowData = await extractFlowData(selectedFlow);
      figma.ui.postMessage({ 
        type: 'flow-selected', 
        name: selectedFlow.name,
        frameCount: flowData.frames.length,
        connectionCount: flowData.connections.length,
        connections: flowData.connections
      });
    } catch (error) {
      figma.ui.postMessage({ 
        type: 'error', 
        message: 'Error extracting flow data: ' + (error as Error).message 
      });
    }
  } else {
    figma.ui.postMessage({ 
      type: 'no-selection', 
      message: 'Please select a frame within a prototype flow' 
    });
  }
}

// Delay initial traversal
setTimeout(() => {
  updateSelectedFlow();
  figma.on('selectionchange', updateSelectedFlow);
}, 100); // Reduced delay to 100ms for faster response

// Function to extract frames and their relationships from a flow
async function extractFlowData(flow: FrameNode) {
  const frames: FrameNode[] = [];
  const connections: { from: string; to: string; action: string }[] = [];
  const processedFrames = new Set<string>();

  // Function to recursively traverse the flow
  async function traverseFlow(node: SceneNode) {
    if (frames.length >= 10) {  // Changed from 10 to 5
      figma.ui.postMessage({ type: 'info', message: 'Maximum of 5 frames reached. Some frames may be omitted.' });
      return;
    }

    if (node.type === 'FRAME' && !processedFrames.has(node.id)) {
      frames.push(node);
      processedFrames.add(node.id);

      // Process connections for the current frame
      const frameConnections = getFrameConnections(node);
      connections.push(...frameConnections);

      // Follow each connection
      for (const conn of frameConnections) {
        const destinationNode = await figma.getNodeByIdAsync(conn.to);
        if (destinationNode && destinationNode.type === 'FRAME') {
          await traverseFlow(destinationNode);
        }
      }
    }
  }

  // Helper function to get connections for a frame
  function getFrameConnections(frame: FrameNode): { from: string; to: string; action: string }[] {
    const frameConnections: { from: string; to: string; action: string }[] = [];

    // Check for prototype connections on the frame itself
    if ('reactions' in frame && frame.reactions) {
      frame.reactions.forEach(reaction => {
        if (reaction.action && reaction.action.type === 'NODE' && reaction.action.destinationId) {
          frameConnections.push({
            from: frame.id,
            to: reaction.action.destinationId,
            action: reaction.trigger?.type || 'unknown'
          });
        }
      });
    }

    // Check for prototype connections on child elements
    if ('children' in frame) {
      frame.children.forEach(child => {
        if ('reactions' in child && child.reactions) {
          child.reactions.forEach(reaction => {
            if (reaction.action && reaction.action.type === 'NODE' && reaction.action.destinationId) {
              frameConnections.push({
                from: frame.id,
                to: reaction.action.destinationId,
                action: reaction.trigger?.type || 'unknown'
              });
            }
          });
        }
      });
    }

    return frameConnections;
  }

  // Start traversal from the main flow node
  await traverseFlow(flow);

  // Export frame images
  const frameData = await Promise.all(frames.map(async (frame) => {
    const image = await frame.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: 2 }
    });
    return {
      id: frame.id,
      name: frame.name,
      image: figma.base64Encode(image),
      link: `https://www.figma.com/file/${figma.fileKey}?node-id=${frame.id}` // Remove currentPage.name
    };
  }));

  // Export the entire flow as one image
  const flowImage = await flow.exportAsync({
    format: 'PNG',
    constraint: { type: 'SCALE', value: 1 }
  });

  console.log(`Found ${frames.length} frames and ${connections.length} connections`);
  connections.forEach(conn => {
    console.log(`Connection: From ${conn.from} to ${conn.to} (${conn.action})`);
  });

  return {
    frames: frameData,
    flowImage: figma.base64Encode(flowImage),
    connections: connections
  };
}

// Function to call GPT-4 API and generate user stories
async function generateUserStories(flowData: Awaited<ReturnType<typeof extractFlowData>>, apiKey: string) {
  const flowName = flowData.frames.length > 0 ? flowData.frames[0].name.split(' ')[0] : 'Unnamed Flow';
  const prompt = `
    Analyze the following user interface flow and generate user stories based on the screens and their relationships. 
    The flow consists of multiple screens, and an overall flow image. 
    Please create comprehensive user stories that cover the main functionalities and user interactions visible in the flow.

    Return the user stories in the following JSON format:
    {
      "userStories": [
        {
          "id": "US001",
          "title": "Short title of the user story",
          "description": "As a [user type], I want to [action], so that [benefit]",
          "acceptanceCriteria": [
            "Criterion 1",
            "Criterion 2"
          ],
          "relatedScreens": [
            {"name": "Screen1", "id": "screen_id_1"},
            {"name": "Screen2", "id": "screen_id_2"}
          ]
        }
      ]
    }

    Flow name: ${flowName}
    Number of screens: ${flowData.frames.length}
    Screen names and IDs: ${flowData.frames.map(f => `${f.name} (${f.id})`).join(', ')}
    
    Connections between screens:
    ${flowData.connections.map(c => `From ${c.from} to ${c.to} on ${c.action}`).join('\n')}
  `;

  console.log("PROMPT:", prompt);
  console.log("Number of frames:", flowData.frames.length);
  console.log("Number of connections:", flowData.connections.length);
  console.log("Connections:", flowData.connections);

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${flowData.flowImage}`,
          },
        },
        ...flowData.frames.map(frame => ({
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${frame.image}`,
          },
        })),
      ],
    },
  ];

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o", // Make sure this is the correct model name
        messages: messages,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content;

    console.log("RESPONSE:", data);

    if (content) {
      return JSON.parse(content);
    } else {
      throw new Error("No content in the response");
    }
  } catch (error) {
    console.error('Error calling OpenAI API:', error);
    throw new Error('Failed to generate user stories: ' + (error as Error).message);
  }
}

// Message handler
figma.ui.onmessage = async (msg: { type: string, [key: string]: unknown }) => {
  if (msg.type === 'generate-stories') {
    const selectedFlow = getSelectedFlow();
    if (selectedFlow) {
      try {
        const flowData = await extractFlowData(selectedFlow);
        const apiKey = msg.apiKey as string;
        const userStories = await generateUserStories(flowData, apiKey);
        
        // Add frame links to the user stories data
        interface UserStory {
          relatedScreens: Array<{ id: string; name: string; link?: string }>;
        }
        
        (userStories.userStories as UserStory[]).forEach((story) => {
          story.relatedScreens = story.relatedScreens.map((screen) => {
            const frame = flowData.frames.find(f => f.id === screen.id);
            return {
              ...screen,
              link: frame ? frame.link : ''
            };
          });
        });
        
        figma.ui.postMessage({ type: 'user-stories', data: userStories });
      } catch (error) {
        figma.ui.postMessage({ type: 'error', message: (error as Error).message });
      }
    } else {
      figma.ui.postMessage({ type: 'error', message: 'No flow selected. Please select a flow and try again.' });
    }
  } else if (msg.type === 'export-stories') {
    // This is no longer needed as we're handling the export in the UI
    console.log('Exporting stories is now handled in the UI');
  }
};

// Immediately show processing message when plugin starts
figma.ui.postMessage({ type: 'processing', message: 'Initializing...' });