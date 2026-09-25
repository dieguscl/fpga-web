//------------------------------------------------------------------
// Testbench for blinky.v
//
// Copyright (c) 2026 Carlos Venegas <carlos@magnitude.es>
// X: @cavearr  github: @cavearr
//
// SPDX-License-Identifier: GPL-3.0-or-later
//------------------------------------------------------------------

`include "apio_testing.vh"

`timescale 10 ns / 1 ns

module blinky_tb ();

  // This defines a managed signal called 'clk'.
  `DEF_CLK

  // Outputs.
  wire [7:0] seven_seg;

  // Instantiate a blinky that toggles segment A every 5 clocks.
  blinky #(
      .DIV(5)
  ) ticker (
      .sys_clk  (clk),
      .seven_seg(seven_seg)
  );

  initial begin
    `TEST_BEGIN(blinky_tb)

    // Free run for 50 clocks.
    `CLKS(30)

    `TEST_END
  end

endmodule
