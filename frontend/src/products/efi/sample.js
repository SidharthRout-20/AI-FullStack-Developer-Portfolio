/**
 * An example failing CI run, so a first-time visitor can see what Jasoos does without having a log to hand. It is
 * labelled as a sample wherever it's used and is never presented as the visitor's own build.
 */
export const SAMPLE = {
  title: 'Sample: CI red after a dependency bump',
  notes: 'Sample investigation. Started failing right after the dependency update was merged; it passed the day before.',
  log: `##[group]Run pytest -q
============================= test session starts ==============================
platform linux -- Python 3.12.4, pytest-8.3.2
collected 48 items

tests/test_invoice.py ..........F.....                                    [ 33%]
tests/test_tax.py ...............F                                       [ 66%]
tests/test_api.py ................                                       [100%]

=================================== FAILURES ===================================
____________________________ test_invoice_total_rounding _______________________

    def test_invoice_total_rounding():
        inv = Invoice(lines=[Line(price=Decimal("19.99"), qty=3)])
>       assert inv.total() == Decimal("59.97")
E       AssertionError: assert Decimal('59.970000') == Decimal('59.97')

tests/test_invoice.py:42: AssertionError
______________________________ test_gst_breakdown ______________________________

    def test_gst_breakdown():
>       out = tax.breakdown(Decimal("100.00"), rate="18%")
E       TypeError: breakdown() got an unexpected keyword argument 'rate'

tests/test_tax.py:88: TypeError
=========================== short test summary info ============================
FAILED tests/test_invoice.py::test_invoice_total_rounding - AssertionError
FAILED tests/test_tax.py::test_gst_breakdown - TypeError: breakdown() got an unexpected keyword argument 'rate'
========================= 2 failed, 46 passed in 3.41s =========================
##[error]Process completed with exit code 1.`,
  diff: `diff --git a/requirements.txt b/requirements.txt
--- a/requirements.txt
+++ b/requirements.txt
@@ -3,4 +3,4 @@ fastapi==0.115.0
-moneyfmt==2.4.1
+moneyfmt==3.0.0
diff --git a/src/billing/tax.py b/src/billing/tax.py
--- a/src/billing/tax.py
+++ b/src/billing/tax.py
@@ -10,7 +10,7 @@ from moneyfmt import quantize
-def breakdown(amount, rate):
+def breakdown(amount, percent):
     """Split an amount into base and GST."""`,
}
