import { PlotError, type PlotInput, renderPlot } from "./html-plot-engine.ts";

self.onmessage = (event: MessageEvent<{ plots: PlotInput[] }>) => {
  self.postMessage({
    results: event.data.plots.map((plot, index) => {
      try {
        return { svg: renderPlot(plot, `plot-${index}`) };
      } catch (error) {
        return {
          error:
            error instanceof PlotError
              ? error.message
              : `Cannot evaluate the plot: ${error instanceof Error ? error.message : error}`,
        };
      }
    }),
  });
};
